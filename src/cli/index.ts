// src/cli/index.ts
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { runInit } from "./init.js";
import { runDeploy } from "./deploy.js";
import { runDestroy } from "./destroy.js";
import { runDoctor } from "./doctor.js";
import { runDescribe } from "./describe.js";
import { runRollback } from "./rollback.js";
import { runTail } from "./tail.js";
import { runEmulate } from "./emulate.js";
import { assertSafeReleaseName } from "../emit/templates/utils.js";

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("--")) {
        flags[key] = nextArg;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      // Short flags (e.g. -y) are always booleans.
      flags[arg.slice(1)] = true;
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
  --allow-no-network-policy  Deploy even if the cluster pod CIDR can't be discovered
                             (NetworkPolicies skipped — the routing service stays
                             reachable from in-cluster pods; not recommended)
  --dry-run                Show what would be done without executing
  `);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);
  const projectDir = process.cwd();

  // Resolve the release name. Precedence:
  //   1. --release-name flag (explicit override)
  //   2. releaseName persisted in .k8s-adapter/infrastructure.json (source of truth
  //      written by `init`) — so read-only commands (doctor/describe/rollback/tail/
  //      destroy) target the ACTUAL deployed release without needing the flag. Without
  //      this, running from a directory whose name differs from the release (e.g. an
  //      `e2e/` dir that deployed release "test-app") derives the wrong cluster name
  //      (`e2e-cluster` vs `test-app-cluster`) and doctor fails to connect.
  //   3. the sanitized directory name (default for a fresh, un-inited project)
  // The directory-name default must degrade gracefully: truncate to the 40-char
  // release-name limit and strip trailing hyphens so a long directory name never
  // throws (only the explicit --release-name flag and the persisted
  // infrastructure.json value hard-fail validation below). If nothing usable
  // survives (e.g. a directory named "!!!"), fall back to a constant.
  const defaultReleaseName =
    path
      .basename(projectDir)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .slice(0, 40)
      .replace(/-+$/, "") || "app";
  let persistedReleaseName: string | undefined;
  const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
  if (existsSync(infraPath)) {
    try {
      const infra = JSON.parse(readFileSync(infraPath, "utf-8"));
      if (typeof infra.releaseName === "string" && infra.releaseName) {
        persistedReleaseName = infra.releaseName;
      }
    } catch {
      // Malformed infrastructure.json — fall back to the directory default.
    }
  }
  const releaseName =
    (flags["release-name"] as string) ?? persistedReleaseName ?? defaultReleaseName;
  // M3: the release name is prefixed into GKE cluster names, K8s resources, IAM role
  // ids, and helm invocations — reject anything outside the safe charset at the CLI
  // boundary (main()'s catch prints the error and exits 1).
  assertSafeReleaseName(releaseName);
  const dryRun = flags["dry-run"] === true;

  switch (command) {
    case "init": {
      const projectId = (flags["project-id"] as string) ?? process.env.GCP_PROJECT_ID;
      const region = (flags["region"] as string) ?? process.env.GCP_REGION ?? "us-central1";
      const hostRaw = (flags["host"] as string) ?? process.env.APP_HOST;
      const hosts = hostRaw
        ? hostRaw
            .split(",")
            .map((h) => h.trim())
            .filter(Boolean)
        : [];
      const bucket =
        (flags["bucket"] as string) ?? (projectId ? `${projectId}-nextjs-static` : undefined);
      const registry =
        (flags["registry"] as string) ??
        (projectId && region ? `${region}-docker.pkg.dev/${projectId}/nextjs` : undefined);

      if (!projectId || hosts.length === 0) {
        console.error("Error: --project-id and --host are required for init");
        console.error(
          "  Example: npx adapter-k8s init --project-id my-project --host app.example.com",
        );
        console.error(
          "  Multiple: npx adapter-k8s init --project-id my-project --host app.example.com,api.example.com",
        );
        process.exit(1);
      }

      await runInit({
        projectId,
        region,
        hosts,
        bucket: bucket!,
        registry: registry!,
        releaseName,
        projectDir,
        dryRun,
      });
      break;
    }

    case "deploy": {
      await runDeploy({
        projectDir,
        releaseName,
        skipBuild: flags["skip-build"] === true,
        skipPush: flags["skip-push"] === true,
        allowNoNetworkPolicy: flags["allow-no-network-policy"] === true,
        dryRun,
      });
      break;
    }

    case "emulate": {
      await runEmulate({
        projectDir,
        skipBuild: flags["skip-build"] === true,
        port: flags["port"] ? parseInt(flags["port"] as string, 10) : 8080,
      });
      break;
    }

    case "rollback": {
      await runRollback({ projectDir, releaseName, dryRun });
      break;
    }

    case "describe": {
      await runDescribe({ projectDir, releaseName });
      break;
    }

    case "doctor": {
      await runDoctor({ projectDir, releaseName });
      break;
    }

    case "tail":
    case "logs": {
      await runTail({ projectDir, releaseName });
      break;
    }

    case "destroy": {
      await runDestroy({
        projectDir,
        releaseName,
        dryRun,
        yes: flags["yes"] === true || flags["y"] === true,
      });
      break;
    }

    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
