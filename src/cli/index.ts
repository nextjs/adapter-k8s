// src/cli/index.ts
import path from "node:path";
import { runInit } from "./init.js";
import { runDeploy } from "./deploy.js";
import { runDestroy } from "./destroy.js";

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const args = argv.slice(2);
  const command = args[0] ?? 'help';
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        flags[key] = nextArg;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  return { command, flags };
}

function printHelp(): void {
  console.log(`
@next-community/adapter-k8s CLI

Usage: npx adapter-k8s <command> [options]

Commands:
  init       Provision GCP infrastructure, scaffold adapter config
  deploy     Build, push images, helm upgrade
  destroy    Tear down all resources

Options:
  --project-id <id>       GCP project ID
  --region <region>        GCP region (default: us-central1)
  --host <hostname>        Application hostname (e.g. app.example.com)
  --bucket <name>          GCS bucket name for static assets
  --registry <url>         Container registry URL
  --release-name <name>    Helm release name (default: current directory name)
  --skip-build             Skip next build (use existing artifacts)
  --skip-push              Skip docker build + push
  --dry-run                Show what would be done without executing
  `);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);
  const projectDir = process.cwd();
  
  // Default release name to the directory name (sanitized)
  const defaultReleaseName = path.basename(projectDir).toLowerCase().replace(/[^a-z0-9]/g, "-");
  const releaseName = (flags["release-name"] as string) ?? defaultReleaseName;
  const dryRun = flags["dry-run"] === true;

  switch (command) {
    case 'init': {
      const projectId = (flags['project-id'] as string) ?? process.env.GCP_PROJECT_ID;
      const region = (flags['region'] as string) ?? process.env.GCP_REGION ?? 'us-central1';
      const host = (flags['host'] as string) ?? process.env.APP_HOST;
      const bucket = (flags['bucket'] as string) ?? (projectId ? `${projectId}-nextjs-static` : undefined);
      const registry = (flags['registry'] as string) ?? (projectId && region ? `${region}-docker.pkg.dev/${projectId}/nextjs` : undefined);

      if (!projectId || !host) {
        console.error('Error: --project-id and --host are required for init');
        console.error('  Example: npx adapter-k8s init --project-id my-project --host app.example.com');
        process.exit(1);
      }

      await runInit({
        projectId, region, host, bucket: bucket!, registry: registry!,
        releaseName, projectDir, dryRun,
      });
      break;
    }

    case 'deploy': {
      await runDeploy({
        projectDir,
        releaseName,
        skipBuild: flags['skip-build'] === true,
        skipPush: flags['skip-push'] === true,
        dryRun,
      });
      break;
    }

    case 'destroy': {
      await runDestroy({ projectDir, releaseName, dryRun });
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
