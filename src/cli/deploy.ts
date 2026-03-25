// src/cli/deploy.ts
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { exec, execOrThrow } from './exec.js';
import { readState, writeState } from './state.js';
import type { GcloudCommand } from './init.js';

export interface DeployOptions {
  projectDir: string;
  releaseName: string;
  skipBuild?: boolean;
  skipPush?: boolean;
  dryRun?: boolean;
}

export interface DockerCommandOptions {
  pools: string[];
  buildId: string;
  registry: string;
  outputDir: string;
  containerStrategy: 'traced-assets' | 'shared-image';
}

export function buildDockerCommands(options: DockerCommandOptions): GcloudCommand[] {
  const { pools, buildId, registry, outputDir, containerStrategy } = options;
  const commands: GcloudCommand[] = [];

  // 0. Configure docker authentication for the registry host
  const registryHost = registry.split("/")[0];
  if (registryHost) {
    commands.push({
      description: `Configure Docker authentication for ${registryHost}`,
      command: "gcloud",
      args: ["auth", "configure-docker", registryHost, "--quiet"],
    });
  }

  if (containerStrategy === "shared-image") {
    const tag = `${registry}/nextjs-app:${buildId}`;
    commands.push({
      description: `Build shared image`,
      command: "docker",
      args: ["build", "-t", tag, `${outputDir}/shared-context`],
    });
    commands.push({
      description: `Push shared image`,
      command: "docker",
      args: ["push", tag],
    });
  } else {
    for (const pool of pools) {
      const tag = `${registry}/nextjs-app-${pool}:${buildId}`;
      commands.push({
        description: `Build ${pool} image`,
        command: "docker",
        args: ["build", "-t", tag, `${outputDir}/pools/${pool}`],
      });
      commands.push({
        description: `Push ${pool} image`,
        command: "docker",
        args: ["push", tag],
      });
    }
  }

  return commands;
}

export function buildHelmUpgradeArgs(options: {
  releaseName: string;
  chartPath: string;
  buildId: string;
  registry: string;
  previousBuildId: string | null;
  overridesFile?: string;
}): string[] {
  const { releaseName, chartPath, buildId, registry, previousBuildId, overridesFile } = options;
  const args = [
    'upgrade', '--install', releaseName, chartPath,
    '--set', `global.image.tag=${buildId}`,
    '--set', `global.image.registry=${registry}`,
    '--set', `build.id=${buildId}`,
  ];

  if (previousBuildId) {
    args.push('--set', `previousBuildId=${previousBuildId}`);
  }

  if (overridesFile && existsSync(overridesFile)) {
    args.push('-f', overridesFile);
  }

  return args;
}

export async function runDeploy(options: DeployOptions): Promise<void> {
  const { projectDir, releaseName, skipBuild, skipPush, dryRun } = options;

  const infraPath = path.join(projectDir, '.k8s-adapter', 'infrastructure.json');
  if (!existsSync(infraPath)) {
    throw new Error(
      'infrastructure.json not found. Run `npx adapter-k8s init` first, ' +
      'or create .k8s-adapter/infrastructure.json manually.'
    );
  }
  const infra = JSON.parse(readFileSync(infraPath, 'utf-8'));

  // 1. Run next build (adapter's onBuildComplete generates artifacts)
  if (!skipBuild) {
    console.log('\n  → Running next build...');
    if (!dryRun) {
      await execOrThrow('npx', ['next', 'build'], { cwd: projectDir });
    } else {
      console.log('    [dry-run] npx next build');
    }
  }

  // 2. Read build metadata to get buildId and pool names
  const outputDir = path.join(projectDir, '.k8s-adapter', 'output');
  const metadataPath = path.join(outputDir, 'build-metadata.json');
  if (!existsSync(metadataPath)) {
    throw new Error(`Build metadata not found at ${metadataPath}. Did next build run?`);
  }
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
  const buildId: string = metadata.buildId;
  const pools: string[] = metadata.pools;

  console.log(`\n  Build ID: ${buildId}`);
  console.log(`  Pools: ${pools.join(', ')}`);

  // 3. Read adapter config to determine container strategy
  // Default to traced-assets if not specified
  const containerStrategy = metadata.containerStrategy ?? 'traced-assets';

  // 4. Docker build + push
  if (!skipPush) {
    const dockerCommands = buildDockerCommands({
      pools,
      buildId,
      registry: infra.containerRegistry,
      outputDir: '.k8s-adapter/output',
      containerStrategy,
    });

    for (const cmd of dockerCommands) {
      console.log(`\n  → ${cmd.description}`);
      if (!dryRun) {
        await execOrThrow(cmd.command, cmd.args, { cwd: projectDir });
      } else {
        console.log(`    [dry-run] ${cmd.command} ${cmd.args.join(' ')}`);
      }
    }
  }

  // 5. Helm upgrade
  const state = readState(projectDir);
  const previousBuildId = state?.buildId ?? null;

  const overridesFile = path.join(projectDir, '.k8s-adapter', 'helm', 'values.override.yaml');
  const helmArgs = buildHelmUpgradeArgs({
    releaseName,
    chartPath: path.join(outputDir, 'chart'),
    buildId,
    registry: infra.containerRegistry,
    previousBuildId,
    overridesFile,
  });

  console.log('\n  → Running helm upgrade...');
  if (!dryRun) {
    await execOrThrow('helm', helmArgs);
  } else {
    console.log(`    [dry-run] helm ${helmArgs.join(' ')}`);
  }

  // 6. Update state
  if (!dryRun) {
    writeState(projectDir, { buildId, previousBuildId });
  }

  console.log(`\n✓ Deploy complete (build: ${buildId})`);

  // 7. Attempt to get Gateway IP
  if (!dryRun) {
    console.log('\nWaiting for GCP Load Balancer to initialize...');
    console.log('(This typically takes 5-10 minutes. You can Ctrl+C and check manually later via `kubectl get gateway`)');
    
    try {
      const ip = await waitForGatewayIP(releaseName);
      if (ip) {
        console.log(`\n🚀 Application is live!`);
        console.log(`   URL: http://${infra.host || 'your-configured-host'}`);
        console.log(`   IP:  ${ip}`);
        console.log(`\nNext: Ensure your DNS A record for ${infra.host || 'your-host'} points to ${ip}`);
      }
    } catch (err) {
      console.log('\nTimed out waiting for Gateway IP. The Load Balancer is still provisioning.');
      console.log('Check progress manually with: `kubectl get gateway`');
    }
  }

  console.log('\n');
}

async function waitForGatewayIP(releaseName: string): Promise<string | null> {
  const maxAttempts = 30; // 5 minutes (10s intervals)
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const output = await execCaptureOrThrow('kubectl', [
        'get', 'gateway', `${releaseName}-gateway`,
        '-o', 'jsonpath={.status.addresses[0].value}',
      ]);
      const ip = output.trim();
      if (ip && /^[0-9.]+$/.test(ip)) {
        return ip;
      }
    } catch {
      // Gateway might not be ready or status field missing yet
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  return null;
}
