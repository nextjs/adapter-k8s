// src/cli/deploy.ts
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { exec, execOrThrow, execCapture } from './exec.js';
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

  // Always build routing service image
  const routingTag = `${registry}/routing-service:${buildId}`;
  commands.push({
    description: 'Build routing service image',
    command: 'docker',
    args: ['build', '-f', `${outputDir}/routing-service/Dockerfile`, '-t', routingTag, `${outputDir}/routing-service`],
  });
  commands.push({
    description: 'Push routing service image',
    command: 'docker',
    args: ['push', routingTag],
  });

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
    '--server-side=true', '--force-conflicts',
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

  // 0. Ensure kubectl is pointing at the right cluster
  if (!dryRun && infra.projectId && infra.region && releaseName) {
    const clusterName = `${releaseName}-cluster`;
    console.log(`\n  → Connecting to GKE cluster "${clusterName}"...`);
    await execOrThrow('gcloud', [
      'container', 'clusters', 'get-credentials', clusterName,
      '--region', infra.region, '--project', infra.projectId, '--quiet',
    ]);
  }

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

  // 5. Pre-flight: ensure static IP exists (Gateway needs it)
  if (!dryRun && infra.projectId) {
    const ipName = `${releaseName}-ip`;
    const ipCheck = await execCapture('gcloud', [
      'compute', 'addresses', 'describe', ipName,
      '--global', '--project', infra.projectId, '--format=value(address)',
    ]);
    if (ipCheck.exitCode !== 0) {
      console.log(`\n  → Creating static IP "${ipName}"...`);
      await execOrThrow('gcloud', [
        'compute', 'addresses', 'create', ipName,
        '--global', '--project', infra.projectId, '--quiet',
      ]);
    }
  }

  // 6. Helm upgrade
  const state = await readState(projectDir, releaseName);
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

  // 6. Update state (local + cluster ConfigMap)
  if (!dryRun) {
    await writeState(projectDir, { buildId, previousBuildId }, releaseName);
  }

  // 7. Zero-downtime cutover: wait for new pods, then clean up old build
  if (!dryRun) {
    // Strip all non-alphanumeric for matching — K8s names replace special chars with dashes,
    // so we need to compare alphanumeric-only to avoid mismatches
    const currentBuildLower = buildId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);

    // 7a. Wait for new deployment to be ready
    console.log(`\n  → Waiting for new pods to be ready...`);
    const newDeployResult = await execCapture('kubectl', [
      'get', 'deployments', '-l', `app.kubernetes.io/name=${releaseName}`,
      '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ]);
    const newDeploys = (newDeployResult.stdout?.trim().split('\n') ?? [])
      .filter(n => n && !n.includes('routing-service') && n.toLowerCase().replace(/[^a-z0-9]/g, '').includes(currentBuildLower));

    for (const deployName of newDeploys) {
      console.log(`    Waiting for ${deployName}...`);
      await execCapture('kubectl', [
        'rollout', 'status', `deployment/${deployName}`, '--timeout=120s',
      ]);
    }

    // 7b. Wait for new pods to be healthy from inside the cluster
    // We check healthz directly on each new pod rather than waiting for GCP LB health
    // (GCP backend health propagation can take 5+ minutes for new backends)
    console.log(`  → Verifying new pods are serving...`);
    let newBuildHealthy = false;
    const maxHealthAttempts = 24; // 2 minutes (5s intervals)
    for (let attempt = 0; attempt < maxHealthAttempts; attempt++) {
      let allHealthy = true;
      let checkedCount = 0;
      for (const deployName of newDeploys) {
        // Get pods for this deployment
        const podsResult = await execCapture('kubectl', [
          'get', 'pods', '-l', `app.kubernetes.io/name=${releaseName}`,
          '-o', 'jsonpath={range .items[*]}{.metadata.name}|{.status.conditions[?(@.type=="Ready")].status}{\"\\n\"}{end}',
        ]);
        if (podsResult.exitCode === 0) {
          for (const line of podsResult.stdout.trim().split('\n')) {
            const [podName, ready] = line.split('|');
            if (!podName || !podName.toLowerCase().replace(/[^a-z0-9]/g, '').includes(currentBuildLower)) continue;
            checkedCount++;
            if (ready !== 'True') allHealthy = false;
          }
        }
      }
      if (allHealthy && checkedCount > 0) {
        console.log(`    All ${checkedCount} new pods ready and serving`);
        newBuildHealthy = true;
        break;
      }
      if (attempt < maxHealthAttempts - 1) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    if (!newBuildHealthy) {
      console.error(`\n  DEPLOY FAILED: New build did not become healthy within 3 minutes.`);
      console.error(`  The previous build is still serving traffic. No cutover performed.\n`);

      // Try to get more diagnostic info
      const newPods = await execCapture('kubectl', [
        'get', 'pods', '-l', `app.kubernetes.io/name=${releaseName},app.kubernetes.io/component!=routing-service`,
        '-o', 'jsonpath={range .items[*]}{.metadata.name}|{.status.phase}{\"\\n\"}{end}',
      ]);
      if (newPods.exitCode === 0 && newPods.stdout.trim()) {
        const podLines = newPods.stdout.trim().split('\n');
        for (const line of podLines) {
          const [podName, phase] = line.split('|');
          if (!podName || !podName.toLowerCase().replace(/[^a-z0-9]/g, '').includes(currentBuildLower)) continue;
          console.error(`  Pod ${podName}: ${phase}`);
          // Try hitting healthz directly
          const healthzResult = await execCapture('kubectl', [
            'exec', podName, '--', 'node', '-e',
            `const http=require("http");http.get("http://localhost:3000/healthz",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>console.log(r.statusCode,d))}).on("error",e=>console.log("ERR",e.message))`,
          ]);
          if (healthzResult.exitCode === 0) {
            console.error(`  Healthz: ${healthzResult.stdout.trim()}`);
          }
          // Get last error from logs
          const logsResult = await execCapture('kubectl', ['logs', podName, '--tail=20']);
          if (logsResult.exitCode === 0) {
            const errorLines = logsResult.stdout.split('\n').filter(l =>
              l.includes('Error') || l.includes('error') || l.includes('FATAL') || l.includes('Cannot find')
            );
            if (errorLines.length > 0) {
              console.error(`  Errors:`);
              for (const err of errorLines.slice(0, 5)) {
                console.error(`    ${err.trim().slice(0, 150)}`);
              }
            } else {
              console.error(`  No errors in pod logs. The issue may be GCP health check configuration.`);
            }
          }
        }
      }

      console.error(`\n  Diagnose:  npx adapter-k8s doctor`);
      console.error(`  Tail logs: npx adapter-k8s tail`);
      // Update state so doctor knows the build was attempted
      await writeState(projectDir, { buildId, previousBuildId }, releaseName);
      process.exit(1);
    }

    // 7c. Cut traffic over: patch each active Service selector to the new build
    const safeBuildId = buildId.toLowerCase().replace(/[^a-z0-9.-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
    console.log(`  → Switching traffic to new build...`);
    for (const pool of pools) {
      const activeServiceName = `${releaseName}-${pool}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
      await execCapture('kubectl', [
        'patch', 'service', activeServiceName, '--type=json',
        '--field-manager=helm', '--force-conflicts',
        '-p', JSON.stringify([{
          op: 'replace',
          path: '/spec/selector/app.kubernetes.io~1version',
          value: safeBuildId,
        }]),
      ]);
    }

    // 7d. Handle old deployments: keep one previous (scaled to 0), delete the rest
    // Don't rely on state.previousBuildId for matching — use the actual deployments.
    const allDeploys = await execCapture('kubectl', [
      'get', 'deployments', '-l', `app.kubernetes.io/name=${releaseName}`,
      '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ]);
    if (allDeploys.exitCode === 0) {
      const oldDeploys = allDeploys.stdout.trim().split('\n').filter(name =>
        name && !name.includes('routing-service') &&
        !name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(currentBuildLower)
      );

      if (oldDeploys.length > 0) {
        // Keep the most recent non-current deploy as "previous" (scale to 0)
        // It's the last one in the list (K8s returns in creation order)
        const previousDeploy = oldDeploys[oldDeploys.length - 1]!;
        console.log(`  → Scaling down previous build: ${previousDeploy}`);
        await execCapture('kubectl', ['scale', `deployment/${previousDeploy}`, '--replicas=0']);

        // Delete anything older
        for (const name of oldDeploys) {
          if (name === previousDeploy) continue;
          console.log(`  → Deleting old build: ${name}`);
          await execCapture('kubectl', ['delete', 'deployment', name]);
          await execCapture('kubectl', ['delete', 'service', name]).catch(() => {});
          await execCapture('kubectl', ['delete', 'healthcheckpolicy', `${name}-hcp`]).catch(() => {});
        }
      }
    }

    // Clean up old route-ext Jobs (they're immutable, each deploy creates a new one)
    const oldJobs = await execCapture('kubectl', [
      'get', 'jobs', '-l', `app.kubernetes.io/name=${releaseName},app.kubernetes.io/component=route-ext-job`,
      '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ]);
    if (oldJobs.exitCode === 0) {
      for (const jobName of oldJobs.stdout.trim().split('\n')) {
        if (!jobName || jobName.toLowerCase().replace(/[^a-z0-9]/g, '').includes(currentBuildLower)) continue;
        await execCapture('kubectl', ['delete', 'job', jobName]);
      }
    }
  }

  console.log(`\n✓ Deploy complete (build: ${buildId})`);

  // 8. Run domain health checks
  if (!dryRun) {
    const { runDomainChecks } = await import('./doctor.js');
    await runDomainChecks({ projectDir, releaseName });
  }

  console.log('');
}

