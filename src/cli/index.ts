// src/cli/index.ts
import path from "node:path";
import { runInit } from "./init.js";
import { runDeploy } from "./deploy.js";
import { runDestroy } from "./destroy.js";
import { runDoctor } from "./doctor.js";
import { runDescribe } from "./describe.js";
import { runRollback } from "./rollback.js";
import { runTail } from "./tail.js";
import { runEmulate } from "./emulate.js";

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
  emulate    Run the full infrastructure locally (Envoy + routing + pool server)
  rollback   Roll back to the previous deployment
  describe   Show architecture diagram with live cluster status
  doctor     Run health checks on your deployment
  tail       Tail logs from all workloads
  destroy    Tear down all resources

Options:
  --project-id <id>       GCP project ID
  --region <region>        GCP region (default: us-central1)
  --host <hostname>        Application hostname(s), comma-separated (e.g. app.example.com,api.example.com)
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
      const hostRaw = (flags['host'] as string) ?? process.env.APP_HOST;
      const hosts = hostRaw ? hostRaw.split(',').map(h => h.trim()).filter(Boolean) : [];
      const bucket = (flags['bucket'] as string) ?? (projectId ? `${projectId}-nextjs-static` : undefined);
      const registry = (flags['registry'] as string) ?? (projectId && region ? `${region}-docker.pkg.dev/${projectId}/nextjs` : undefined);

      if (!projectId || hosts.length === 0) {
        console.error('Error: --project-id and --host are required for init');
        console.error('  Example: npx adapter-k8s init --project-id my-project --host app.example.com');
        console.error('  Multiple: npx adapter-k8s init --project-id my-project --host app.example.com,api.example.com');
        process.exit(1);
      }

      await runInit({
        projectId, region, hosts, bucket: bucket!, registry: registry!,
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

    case 'emulate': {
      await runEmulate({
        projectDir,
        skipBuild: flags['skip-build'] === true,
        port: flags['port'] ? parseInt(flags['port'] as string, 10) : 8080,
      });
      break;
    }

    case 'rollback': {
      await runRollback({ projectDir, releaseName, dryRun });
      break;
    }

    case 'describe': {
      await runDescribe({ projectDir, releaseName });
      break;
    }

    case 'doctor': {
      await runDoctor({ projectDir, releaseName });
      break;
    }

    case 'tail':
    case 'logs': {
      await runTail({ projectDir, releaseName });
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
