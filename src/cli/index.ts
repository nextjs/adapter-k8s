// src/cli/index.ts
import path from "node:path";
import { infrastructurePath, infrastructureWritePath } from "./infrastructure-validation.js";
import { sanitizeForTerminal } from "./terminal.js";
import { existsSync, readFileSync } from "node:fs";
import { runInit } from "./init.js";
import { runDeploy } from "./deploy.js";
import { runEmit } from "./emit.js";
import { runDestroy } from "./destroy.js";
import { runDoctor } from "./doctor.js";
import { runDescribe } from "./describe.js";
import { runRollback } from "./rollback.js";
import { runTail } from "./tail.js";
import { runEmulate } from "./emulate.js";
import { assertSafeReleaseName } from "../emit/templates/utils.js";

// Boolean flags NEVER consume the following argument. The old parser let `--dry-run foo`
// swallow `foo` as the flag's string value, and every consumer checks
// `flags["dry-run"] === true` — so a stray positional silently DISABLED the dry-run
// guard on destroy/deploy (the dangerous direction for an irreversible command).
const BOOLEAN_FLAGS = new Set([
  "dry-run",
  "skip-build",
  "skip-push",
  "yes",
  "y",
  "allow-no-network-policy",
  "allow-mutable-tags",
  "allow-unretained-manifest",
  "standard",
  // GitOps PR1 (emit): render the committable bundle instead of deploying, and the
  // explicit first-deploy assertion (never inferred — see resolvePreviousBuildId).
  "render-only",
  "first-deploy",
  "help",
  "h",
]);

// Value flags REQUIRE a value — a missing value is a hard error, never a silent `true`
// (a `--project-id` that parsed as boolean would later crash deep inside init).
const VALUE_FLAGS = new Set([
  "project-id",
  "region",
  "host",
  "bucket",
  "registry",
  "release-name",
  "namespace",
  "port",
  // GitOps PR1 (emit): the previous-build pin and the secret externalization mode.
  "previous-build",
  "secrets",
]);

export function parseArgs(argv: string[]): {
  command: string;
  flags: Record<string, string | boolean>;
} {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      let key = arg.slice(2);
      // Support the --flag=value form (previously `--project-id=x` registered a flag
      // literally named "project-id=x" that no consumer reads).
      let inlineValue: string | undefined;
      const eq = key.indexOf("=");
      if (eq !== -1) {
        inlineValue = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (BOOLEAN_FLAGS.has(key)) {
        if (inlineValue !== undefined) {
          console.warn(`Warning: --${key} is a boolean flag; ignoring "=${inlineValue}"`);
        }
        flags[key] = true;
      } else if (VALUE_FLAGS.has(key)) {
        if (inlineValue !== undefined) {
          if (!inlineValue) throw new Error(`Flag --${key} requires a non-empty value`);
          flags[key] = inlineValue;
        } else {
          const nextArg = args[i + 1];
          if (!nextArg || nextArg.startsWith("-")) {
            throw new Error(`Flag --${key} requires a value (e.g. --${key}=VALUE)`);
          }
          flags[key] = nextArg;
          i++;
        }
      } else {
        // Unknown flag — warn so a typo (e.g. `--dryrun`) is visible instead of silently
        // registering a flag nobody reads. Never consume the next arg: we cannot know
        // whether it was meant as this flag's value or as a positional.
        console.warn(`Warning: unknown flag --${key} (ignored)`);
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      // Short flags (e.g. -y) are always booleans.
      const key = arg.slice(1);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else {
        console.warn(`Warning: unknown flag -${key} (ignored)`);
      }
    } else {
      console.warn(`Warning: unexpected argument "${arg}" (ignored)`);
    }
  }

  // --help / -h were recognized boolean flags that no command consumed, so
  // `adapter-k8s deploy --help` ran a REAL deploy. Route them to the help printer
  // instead of dispatching the command.
  if (flags["help"] === true || flags["h"] === true) {
    return { command: "help", flags };
  }

  // Validate --port at the boundary: parseInt("abc", 10) is NaN, which would otherwise
  // flow into emulate's Envoy listener config and readiness probe silently.
  if (flags["port"] !== undefined) {
    const p = Number(flags["port"]);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error(
        `Flag --port must be an integer between 1 and 65535 (got "${flags["port"]}")`,
      );
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
  emit       Render a committable GitOps bundle (.k8s-adapter/gitops/) — build, push,
             resolve digests, NO cluster contact. Alias: deploy --render-only
  emulate    Run the full infrastructure locally (Envoy + routing + pool server)
  rollback   Roll back to the previous deployment
  describe   Show architecture diagram with live cluster status
  doctor     Run health checks on your deployment
  tail       Tail logs from all workloads
  destroy    Tear down this release's resources (shared infrastructure is retained)

Options:
  --project-id <id>        GCP project ID (init)
  --region <region>        GCP region (default: us-central1)
  --host <hostname>        Application hostname(s), comma-separated (e.g. app.example.com,api.example.com)
  --bucket <name>          GCS bucket name for static assets (init)
  --registry <url>         Container registry URL (init)
  --release-name <name>    Helm release name (default: current directory name)
  --namespace <name>       Kubernetes namespace (init; default: persisted value or default)
  --standard               Provision a GKE Standard cluster instead of Autopilot (init)
  --skip-build             Skip next build (deploy, emulate)
  --skip-push              Skip docker build + push (deploy)
  --port <port>            Listener port for the local Envoy proxy (emulate; default: 8080)
  --yes, -y                Skip the confirmation prompt (destroy; deploy's unpinned-context guard)
  --allow-unretained-manifest  Deploy even if the outgoing build's routing manifest cannot
                              be retained (rollback to it becomes image-only; recorded in
                              deploy state so doctor can report it)
  --allow-no-network-policy  Deploy even if the cluster pod CIDR can't be discovered
  --allow-mutable-tags     Deploy by image tag when no digest can be resolved
                              (NetworkPolicies skipped — the routing service stays
                              reachable from in-cluster pods; not recommended)
  --previous-build <id>    The build the bundle's Service selectors stay pinned to (emit).
                              Default: the prior bundle's emit-metadata.json. With neither,
                              emit refuses — assert a genuine first deploy explicitly.
  --first-deploy           Assert a genuine first deploy: selectors render at the NEW
                              build (emit; never inferred from a missing prior bundle)
  --secrets <mode>         external (default): omit secret templates from the bundle chart
                              and emit an ExternalSecret placeholder + README key table.
                              inline: verbatim chart with a loud warning (emit)
  --dry-run                Show what would be done without executing

Flags may be given as --flag value or --flag=value. Boolean flags (e.g. --dry-run)
never take a value.
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
  let persistedNamespace: string | undefined;
  const infraPath =
    command === "init" ? infrastructureWritePath(projectDir) : infrastructurePath(projectDir);
  if (existsSync(infraPath)) {
    try {
      const infra = JSON.parse(readFileSync(infraPath, "utf-8"));
      if (typeof infra.releaseName === "string" && infra.releaseName) {
        persistedReleaseName = infra.releaseName;
      }
      if (typeof infra.namespace === "string" && infra.namespace) {
        persistedNamespace = infra.namespace;
      }
    } catch (err) {
      // Malformed infrastructure.json — fall back to the directory default, but name
      // the file: a corrupt file silently flipping the derived release name would
      // target the wrong cluster.
      console.warn(
        `Warning: could not parse ${infraPath} (${(err as Error).message}) — ` +
          `falling back to the directory-name release default.`,
      );
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
      const initNamespace = (flags["namespace"] as string | undefined) ?? persistedNamespace;

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
        ...(initNamespace ? { namespace: initNamespace } : {}),
        projectDir,
        dryRun,
        // --standard opts out of the Autopilot default (Standard clusters get
        // --enable-network-policy, which Autopilot rejects).
        autopilot: flags["standard"] !== true,
      });
      break;
    }

    case "emit":
    case "deploy": {
      // `deploy --render-only` is the documented alias for `emit` (GitOps PR1, §4.2):
      // both run the pipeline-safe steps and write the bundle, never touching a cluster.
      if (command === "emit" || flags["render-only"] === true) {
        const secrets = flags["secrets"] as string | undefined;
        if (secrets !== undefined && secrets !== "external" && secrets !== "inline") {
          throw new Error(
            `Flag --secrets must be "external" or "inline" (got ${JSON.stringify(secrets)})`,
          );
        }
        await runEmit({
          projectDir,
          releaseName,
          skipBuild: flags["skip-build"] === true,
          skipPush: flags["skip-push"] === true,
          allowMutableTags: flags["allow-mutable-tags"] === true,
          allowNoNetworkPolicy: flags["allow-no-network-policy"] === true,
          previousBuild: flags["previous-build"] as string | undefined,
          firstDeploy: flags["first-deploy"] === true,
          ...(secrets ? { secrets } : {}),
        });
        break;
      }
      await runDeploy({
        projectDir,
        releaseName,
        skipBuild: flags["skip-build"] === true,
        skipPush: flags["skip-push"] === true,
        allowNoNetworkPolicy: flags["allow-no-network-policy"] === true,
        allowMutableTags: flags["allow-mutable-tags"] === true,
        // N30 / N29: opt out of the fatal routing-manifest retention, and skip the
        // unpinned-kubectl-context confirmation in CI.
        allowUnretainedManifest: flags["allow-unretained-manifest"] === true,
        yes: flags["yes"] === true || flags["y"] === true,
        dryRun,
      });
      break;
    }

    case "emulate": {
      await runEmulate({
        projectDir,
        skipBuild: flags["skip-build"] === true,
        // --port was range-validated in parseArgs.
        port: flags["port"] !== undefined ? Number(flags["port"]) : 8080,
      });
      break;
    }

    case "rollback": {
      await runRollback({
        projectDir,
        releaseName,
        dryRun,
        yes: flags["yes"] === true || flags["y"] === true,
      });
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

// Run main() only when this module is the CLI entry point — unit tests import parseArgs
// and must not trigger a real CLI invocation (or its process.exit) as a side effect.
// Vitest sets VITEST in its workers; the bundled bin never does.
if (!process.env.VITEST) {
  main().catch((err) => {
    // L14: this is the LAST sink for every thrown message, and those messages routinely
    // embed captured kubectl/gcloud output. Sanitize here as a backstop so a path that
    // forgets to strip control sequences at the point of capture still cannot repaint the
    // operator's terminal on the way out.
    console.error("\nError:", sanitizeForTerminal(String(err?.message ?? err)));
    process.exit(1);
  });
}
