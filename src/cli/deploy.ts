// src/cli/deploy.ts
import path from "node:path";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execOrThrow, execCapture } from "./exec.js";
import { readState, writeState } from "./state.js";
import { invalidateCdnBuildTag } from "./cdn-invalidate.js";
import { cdnTagForBuildId } from "../cdn-tags.js";
import { retainLiveRoutingManifest } from "./rollback.js";
import { renderDeployment } from "../emit/templates/deployment.js";
import { renderService } from "../emit/templates/service.js";
import { renderHPA } from "../emit/templates/hpa.js";
import { renderValkeySecret } from "../emit/templates/valkey-secret.js";
import { provisionMemorystore, buildDeleteMemorystoreCommand } from "./provision-cache.js";
import { isAlreadyGoneError } from "./destroy.js";
import { MIN_GKE_VERSION_FOR_CDN } from "./gke-version.js";
import { routeExtJobName } from "../emit/templates/route-ext-update-job.js";
import {
  routingManifestSnapshotName,
  routingServiceDeploymentName,
} from "../emit/templates/routing-manifest-configmap.js";
// Import the SAME sanitizer that stamps pod names and version labels (deployment.ts /
// service.ts). The blue/green cutover patches the active Service selector to this exact
// value, so it MUST match the pod label byte-for-byte — a divergent local copy that
// omitted the `b-` prefix drained the Service to zero endpoints and 503'd the site.
import { sanitizeK8sName } from "../emit/templates/utils.js";
import {
  assertSafeBuildId,
  findBuildIdNameCollision,
  assertSafeImageRegistry,
  assertSafeNamespace,
  assertSafeProjectId,
  assertSafeRegion,
  poolResourceNames,
  // init binds Workload Identity to [default/<release>-deploy-sa]; the release lives
  // in the literal "default" namespace. Pin it on every kubectl/helm call instead of
  // trusting whatever namespace the operator's context happens to have.
  K8S_NAMESPACE,
} from "../emit/templates/utils.js";
import { sanitizeForTerminal } from "./terminal.js";
import type { GcloudCommand } from "./init.js";

export interface DeployOptions {
  projectDir: string;
  releaseName: string;
  skipBuild?: boolean;
  skipPush?: boolean;
  dryRun?: boolean;
  /**
   * Explicit opt-out of the fail-closed NetworkPolicy posture: allow the deploy to
   * proceed WITHOUT pod-CIDR NetworkPolicies when the cluster CIDR can't be discovered.
   * Without this flag a discovery failure aborts the deploy — silently shipping the
   * chart without its network isolation would re-open the in-cluster secret-extraction
   * path the policies close (H1).
   */
  allowNoNetworkPolicy?: boolean;
}

export interface DockerCommandOptions {
  pools: string[];
  buildId: string;
  registry: string;
  outputDir: string;
  containerStrategy: "traced-assets" | "shared-image";
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
    description: "Build routing service image",
    command: "docker",
    args: [
      "build",
      "-f",
      `${outputDir}/routing-service/Dockerfile`,
      "-t",
      routingTag,
      `${outputDir}/routing-service`,
    ],
  });
  commands.push({
    description: "Push routing service image",
    command: "docker",
    args: ["push", routingTag],
  });

  return commands;
}

// L15: pool names are read from build-metadata.json and used in chart file paths and
// docker build contexts — a malicious or corrupt name (e.g. "../x") could otherwise
// escape the chart templates directory.
export function assertSafePoolName(poolName: string): void {
  if (!/^[a-z0-9-]+$/.test(poolName)) {
    throw new Error(
      `Invalid pool name "${poolName}" in build-metadata.json: must match /^[a-z0-9-]+$/ ` +
        `(lowercase letters, digits, hyphens). Refusing to use it in file paths.`,
    );
  }
  // "routing-service" is the reserved routing-tier Deployment name (<release>-routing-service,
  // updated in place per build, verified/reverted separately from pools). A pool with this
  // name would collide with it: readiness checks, cleanup classification, and rollback's
  // edge revert all key off that exact name.
  if (poolName === "routing-service") {
    throw new Error(
      `Invalid pool name "routing-service" in build-metadata.json: reserved for the routing ` +
        `tier (<release>-routing-service). Rename the pool (check the adapter's route ` +
        `classification config) and rebuild.`,
    );
  }
}

export function buildHelmUpgradeArgs(options: {
  releaseName: string;
  chartPath: string;
  buildId: string;
  registry: string;
  previousBuildId: string | null;
  overridesFile?: string;
  podCidrs?: string | null;
}): string[] {
  const { releaseName, chartPath, buildId, registry, previousBuildId, overridesFile, podCidrs } =
    options;
  // H2: these values land in `helm --set` assignments — reject helm metacharacters
  // (","  "\"  quotes) before they can split one assignment into several. The buildId
  // comes from generateBuildId()/git refs and the registry from infrastructure.json.
  assertSafeBuildId(buildId);
  assertSafeImageRegistry(registry);
  if (previousBuildId) assertSafeBuildId(previousBuildId);
  const args = [
    "upgrade",
    "--install",
    releaseName,
    chartPath,
    "--server-side=true",
    "--force-conflicts",
    // Cache Secrets are Helm-owned in every enabled mode. This adopts Secrets created by older
    // adapter versions that provisioned managed-cache credentials imperatively with kubectl.
    "--take-ownership",
    // The release lives in the namespace init binds Workload Identity to — pin it rather
    // than installing into whatever namespace the operator's context happens to have.
    "--namespace",
    "default",
    "--create-namespace",
    "--set",
    `global.image.tag=${buildId}`,
    "--set",
    `global.image.registry=${registry}`,
    "--set",
    `build.id=${buildId}`,
    "--set",
    `activeBuildId=${sanitizeK8sName(previousBuildId ?? buildId)}`,
  ];

  if (previousBuildId) {
    args.push("--set", `previousBuildId=${previousBuildId}`);
  }

  // NetworkPolicy interface with the chart: discovered cluster pod CIDR(s), passed as a
  // helm brace list (CIDRs contain no commas, so no escaping needed).
  if (podCidrs) {
    args.push("--set", `global.networkPolicy.podCidrs={${podCidrs}}`);
  }

  if (overridesFile && existsSync(overridesFile)) {
    args.push("-f", overridesFile);
  }

  return args;
}

/**
 * Discover the cluster's pod CIDR for the chart-rendered NetworkPolicies. FAIL-CLOSED:
 * the helm `podCidrs` guard renders NO policy when the value is absent, so a failed or
 * malformed lookup throws (the NetworkPolicies are what close in-cluster access to the
 * routing service's dispatch secret, H1) — unless the operator explicitly opts out with
 * `--allow-no-network-policy`, in which case this warns loudly and returns null.
 */
export async function discoverClusterPodCidr({
  clusterName,
  region,
  projectId,
  allowNoNetworkPolicy = false,
}: {
  clusterName: string;
  region: string;
  projectId: string;
  allowNoNetworkPolicy?: boolean;
}): Promise<string | null> {
  const cidrResult = await execCapture("gcloud", [
    "container",
    "clusters",
    "describe",
    clusterName,
    "--region",
    region,
    "--project",
    projectId,
    "--format=value(clusterIpv4Cidr)",
  ]);
  const discovered = cidrResult.exitCode === 0 ? cidrResult.stdout.trim() : "";
  // One or more comma-separated IPv4 CIDRs — anything else would corrupt the helm list.
  const CIDR_LIST_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}(,(\d{1,3}\.){3}\d{1,3}\/\d{1,2})*$/;
  if (CIDR_LIST_RE.test(discovered)) return discovered;

  if (allowNoNetworkPolicy) {
    console.warn(
      "  ! Could not discover the cluster pod CIDR — continuing WITHOUT NetworkPolicies " +
        "(--allow-no-network-policy). The routing service is reachable from any in-cluster " +
        "pod; re-run without the flag once the cluster is describable.",
    );
    return null;
  }
  throw new Error(
    `Could not discover the pod CIDR for cluster "${clusterName}" ` +
      `(gcloud exited ${cidrResult.exitCode}${discovered ? `, unexpected value ${JSON.stringify(discovered)}` : ", empty output"}). ` +
      `The chart's NetworkPolicies require it; refusing to deploy without network isolation. ` +
      `Fix cluster access, or pass --allow-no-network-policy to explicitly deploy without them.`,
  );
}

export async function runDeploy(options: DeployOptions): Promise<void> {
  const { projectDir, releaseName, skipBuild, skipPush, dryRun, allowNoNetworkPolicy } = options;

  const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
  if (!existsSync(infraPath)) {
    throw new Error(
      "infrastructure.json not found. Run `npx adapter-k8s init` first, " +
        "or create .k8s-adapter/infrastructure.json manually.",
    );
  }
  let infra: Record<string, string | undefined>;
  try {
    infra = JSON.parse(readFileSync(infraPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to parse ${infraPath}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Fix the file by hand or regenerate it with \`npx adapter-k8s init\`.`,
    );
  }

  // H2: infrastructure.json values reach the privileged route-ext Job script
  // (projectId/region), extension-chain authority/YAML (namespace), and helm --set
  // assignments / docker tags (containerRegistry) — validate before any use.
  if (infra.projectId) assertSafeProjectId(infra.projectId);
  if (infra.region) assertSafeRegion(infra.region);
  if (infra.namespace) assertSafeNamespace(infra.namespace);
  // Same fail-fast as build time (adapter.ts): every kubectl/helm call below pins
  // K8S_NAMESPACE, but the build-time extension chain derives the ext_proc authority
  // from infra.namespace — honoring any other value would put the workloads in
  // "default" while the GXLB callout targets the other namespace, failing every edge
  // callout. Reject instead of deploying skewed. (Deploy-time too, not just build
  // time: --skip-build deploys ship a chart built elsewhere, possibly before this
  // guard existed.)
  if (infra.namespace !== undefined && infra.namespace !== K8S_NAMESPACE) {
    throw new Error(
      `Unsupported namespace "${infra.namespace}" in .k8s-adapter/infrastructure.json: ` +
        `this adapter version deploys only to the "${K8S_NAMESPACE}" namespace (init binds ` +
        `Workload Identity to ${K8S_NAMESPACE}/<release>-deploy-sa and every kubectl/helm ` +
        `call pins it). Remove "namespace" from infrastructure.json.`,
    );
  }
  if (infra.containerRegistry) assertSafeImageRegistry(infra.containerRegistry);
  // Without a registry, docker tags and the helm --set image registry can't be formed —
  // fail with a pointer to the fix instead of a raw TypeError deep in the deploy.
  if (!infra.containerRegistry) {
    throw new Error(
      "infrastructure.json is missing containerRegistry — image tags cannot be formed. " +
        "Run `npx adapter-k8s init` to regenerate it, or set containerRegistry in " +
        ".k8s-adapter/infrastructure.json.",
    );
  }

  // 0. Ensure kubectl is pointing at the right cluster
  if (!dryRun && infra.projectId && infra.region && releaseName) {
    const clusterName = `${releaseName}-cluster`;
    console.log(`\n  → Connecting to GKE cluster "${clusterName}"...`);
    await execOrThrow("gcloud", [
      "container",
      "clusters",
      "get-credentials",
      clusterName,
      "--region",
      infra.region,
      "--project",
      infra.projectId,
      "--quiet",
    ]);
  }

  // 0b. Discover the cluster pod CIDR for chart-rendered NetworkPolicies (fail-closed —
  // see discoverClusterPodCidr).
  let podCidr: string | null = null;
  if (!dryRun && infra.projectId && infra.region && releaseName) {
    podCidr = await discoverClusterPodCidr({
      clusterName: `${releaseName}-cluster`,
      region: infra.region,
      projectId: infra.projectId,
      allowNoNetworkPolicy: allowNoNetworkPolicy ?? false,
    });
  }

  // 1. Run next build (adapter's onBuildComplete generates artifacts)
  if (!skipBuild) {
    console.log("\n  → Running next build...");
    if (!dryRun) {
      await execOrThrow("npx", ["next", "build"], { cwd: projectDir });
    } else {
      console.log("    [dry-run] npx next build");
    }
  }

  // 2. Read build metadata to get buildId and pool names
  const outputDir = path.join(projectDir, ".k8s-adapter", "output");
  const metadataPath = path.join(outputDir, "build-metadata.json");
  if (!existsSync(metadataPath)) {
    throw new Error(`Build metadata not found at ${metadataPath}. Did next build run?`);
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
  const buildId: string = metadata.buildId;
  // H2: the buildId comes from generateBuildId()/git refs and is spliced into helm
  // --set assignments and image tags — reject helm/shell metacharacters up front.
  assertSafeBuildId(buildId);
  const pools: string[] = metadata.pools;
  if (!Array.isArray(pools)) {
    throw new Error(`build-metadata.json is missing a "pools" array. Did next build run?`);
  }
  for (const poolName of pools) assertSafePoolName(poolName);

  console.log(`\n  Build ID: ${buildId}`);
  console.log(`  Pools: ${pools.join(", ")}`);

  // Managed cache: provision Memorystore and inject its discovered endpoint into the Helm chart.
  // This keeps the Valkey Secret Helm-owned in both managed and BYO modes, so switching modes
  // updates one resource instead of crossing the kubectl/Helm ownership boundary.
  //
  // Pre-`cacheManaged` build artifacts (older adapter versions) carry cacheEnabled but no
  // cacheManaged flag at all. A `--skip-build` deploy over such an artifact must treat
  // enabled-with-unknown-mode as MANAGED: falling into the teardown branch below would
  // delete a live managed Memorystore out from under the serving build. (Provisioning is
  // idempotent, so re-running the managed branch against an existing instance is safe.)
  const cacheManaged: boolean = metadata.cacheManaged ?? metadata.cacheEnabled === true;
  if (cacheManaged && !dryRun) {
    // Fail loudly rather than silently shipping without a shared cache: managed provisioning
    // needs the project + region. (BYO cache sets cache.url and never reaches this branch.)
    if (!infra.projectId || !infra.region) {
      throw new Error(
        "cache.enabled with managed Memorystore requires infrastructure.json to have projectId " +
          "and region. Set cache.url for a bring-your-own instance, or re-run `adapter-k8s init`.",
      );
    }
    console.log("\n  → Provisioning managed cache (Memorystore)...");
    const ms = (
      metadata as {
        cacheMemorystore?: { region?: string; sizeGb?: number; tier?: string; auth?: boolean };
      }
    ).cacheMemorystore;
    const cacheRegion = ms?.region ?? infra.region;
    const endpoint = await provisionMemorystore({
      projectId: infra.projectId,
      region: cacheRegion,
      releaseName,
      ...(ms?.sizeGb ? { sizeGb: ms.sizeGb } : {}),
      ...(ms?.tier ? { tier: ms.tier } : {}),
      ...(ms?.auth ? { auth: true } : {}),
      log: (m: string) => console.log(m),
    });
    // Persist the actual region immediately after provisioning. Any later failure (writing the
    // chart, Helm connectivity, rollout) must still leave destroy enough state to find the paid
    // instance, especially when cache.memorystore.region differs from the cluster region.
    if (infra.cacheRegion !== cacheRegion) {
      infra.cacheRegion = cacheRegion;
      writeFileSync(infraPath, JSON.stringify(infra, null, 2));
    }

    // AUTH mode ⇒ TLS endpoint (Memorystore requires in-transit encryption for AUTH).
    const url = `${endpoint.authString ? "rediss" : "redis"}://${endpoint.host}:${endpoint.port}`;
    const secretPath = path.join(outputDir, "chart", "templates", "valkey-secret.yaml");
    // M4a: this file carries the cache connection Secret — owner-read/write only.
    writeFileSync(
      secretPath,
      renderValkeySecret({
        releaseName,
        url,
        ...(endpoint.authString ? { password: endpoint.authString } : {}),
        ...(endpoint.caCert ? { ca: endpoint.caCert } : {}),
      }),
      { mode: 0o600 },
    );
    // writeFileSync's mode only applies when CREATING the file — an existing file keeps
    // its old mode, so a previously world-readable secret file would stay that way.
    chmodSync(secretPath, 0o600);
    console.log(`    Cache Secret ${releaseName}-valkey staged for Helm → ${url}`);
  } else if (!cacheManaged && !dryRun) {
    // The current build is NOT using the managed cache (disabled entirely, or BYO via
    // cache.url). If a managed Memorystore was previously provisioned for this release
    // (infra.cacheRegion persisted at provision time), tear it down — otherwise the
    // managed→BYO switch silently leaks the paid instance (the teardown used to fire
    // only when the cache was fully disabled). BYO-from-the-start never sets
    // infra.cacheRegion, so this stays a no-op there.
    if (!metadata.cacheEnabled) {
      // Cache fully disabled: also remove the Secret so new pods stop receiving
      // VALKEY_URL (the pod template always mounts the optional Secret). Not done for
      // BYO: the chart then carries its own Helm-owned valkey-secret.yaml instead.
      const secretDelete = await execCapture("kubectl", [
        "delete",
        "secret",
        `${releaseName}-valkey`,
        "-n",
        K8S_NAMESPACE,
        "--ignore-not-found",
      ]);
      if (secretDelete.stdout.trim())
        console.log(`\n  → Removed cache Secret ${releaseName}-valkey`);
    }
    if (infra.cacheRegion) {
      console.log(
        `  → Deleting managed cache (Memorystore) — ${metadata.cacheEnabled ? "switched to bring-your-own cache" : "cache is disabled"}...`,
      );
      // projectId is only absent when infrastructure.json is hand-broken; the delete then
      // fails gcloud-side and lands in the warn path below (the instance stays billed).
      const del = buildDeleteMemorystoreCommand(
        releaseName,
        infra.cacheRegion,
        infra.projectId ?? "",
      );
      const res = await execCapture(del.command, del.args);
      if (res.exitCode === 0 || isAlreadyGoneError(res.stderr)) {
        delete infra.cacheRegion;
        writeFileSync(infraPath, JSON.stringify(infra, null, 2));
        console.log(`    ${del.desc} deleted`);
      } else {
        console.warn(
          `    Warning: could not delete ${del.desc} in ${infra.cacheRegion} — it may still be ` +
            `billed. Delete it manually or run \`adapter-k8s destroy\`.\n    ${res.stderr.trim()}`,
        );
      }
    }
  }

  // 3. Read adapter config to determine container strategy
  // Default to traced-assets if not specified
  const containerStrategy = metadata.containerStrategy ?? "traced-assets";

  // 4. Docker build + push
  if (!skipPush) {
    const dockerCommands = buildDockerCommands({
      pools,
      buildId,
      registry: infra.containerRegistry,
      outputDir: ".k8s-adapter/output",
      containerStrategy,
    });

    for (const cmd of dockerCommands) {
      console.log(`\n  → ${cmd.description}`);
      if (!dryRun) {
        await execOrThrow(cmd.command, cmd.args, { cwd: projectDir });
      } else {
        console.log(`    [dry-run] ${cmd.command} ${cmd.args.join(" ")}`);
      }
    }
  }

  // 5. Pre-flight: ensure static IP exists (Gateway needs it)
  if (!dryRun && infra.projectId) {
    const ipName = `${releaseName}-ip`;
    const ipCheck = await execCapture("gcloud", [
      "compute",
      "addresses",
      "describe",
      ipName,
      "--global",
      "--project",
      infra.projectId,
      "--format=value(address)",
    ]);
    if (ipCheck.exitCode !== 0) {
      console.log(`\n  → Creating static IP "${ipName}"...`);
      await execOrThrow("gcloud", [
        "compute",
        "addresses",
        "create",
        ipName,
        "--global",
        "--project",
        infra.projectId,
        "--quiet",
      ]);
    }
  }

  // 5b. Pre-flight: the chart carries a Cloud CDN filter only when cdn.enabled — the cluster
  // must know the GCPHTTPFilter CRD (GKE >= 1.35.2-gke.1751000) or the apply would fail with
  // an opaque server error. Capability-detect the CRD rather than parsing version strings.
  const chartHasCdn = existsSync(
    path.join(outputDir, "chart", "templates", "cdn-http-filter.yaml"),
  );
  if (!dryRun && chartHasCdn) {
    const crdCheck = await execCapture("kubectl", [
      "get",
      "crd",
      "gcphttpfilters.networking.gke.io",
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    if (crdCheck.exitCode !== 0) {
      // kubectl itself failed (no context, expired credentials, unreachable API server) —
      // NOT a version problem. `--ignore-not-found` returns exit 0 for a genuinely absent
      // CRD, so a non-zero exit is always a connectivity/auth failure. Don't send the user
      // to upgrade a cluster they can't even reach.
      const detail = crdCheck.stderr.trim();
      throw new Error(
        `Cloud CDN is enabled (cdn.enabled: true) but the GCPHTTPFilter CRD check could not ` +
          `reach the cluster (kubectl exited ${crdCheck.exitCode}). Check your kubectl context ` +
          `and credentials.${detail ? `\nkubectl: ${detail}` : ""}`,
      );
    }
    if (!crdCheck.stdout.trim()) {
      // Cluster reachable, CRD genuinely absent → the cluster is too old.
      throw new Error(
        `Cloud CDN is enabled (cdn.enabled: true) but this cluster does not have the ` +
          `GCPHTTPFilter CRD. Cloud CDN for GKE Gateway requires GKE >= ${MIN_GKE_VERSION_FOR_CDN}. ` +
          `Upgrade the cluster, or set provider.gke.cdn.enabled: false in adapter config.`,
      );
    }
  }

  // 6. Helm upgrade
  // L13: dry-run must not touch the cluster — skip the cluster ConfigMap read and use
  // local state only (best-effort).
  const state = dryRun
    ? await readState(projectDir).catch(() => null)
    : await readState(projectDir, releaseName);
  const previousBuildId = state?.buildId ?? null;
  // H2: previousBuildId is spliced into a helm --set assignment below.
  if (previousBuildId) assertSafeBuildId(previousBuildId);
  // The build-time collision guard (adapter.ts) can't see deploy-time state: if any of
  // this build's COMPOSED resource names sanitizes to the SAME K8s name as the
  // currently-serving build's, the two builds' resources become indistinguishable —
  // pods carry identical version labels (split-brain cutover), retained previous-build
  // manifests overwrite the serving ones, and cleanup deletes the wrong build.
  // Comparing the bare sanitized build ids is NOT enough: names collide on the COMPOSED
  // truncated form — a long `<release>-<pool>-` prefix can push the differing part of
  // the build id past the 63-char boundary even when the ids differ well inside their
  // own 63 chars. Compare exactly what the templates emit: the pool Deployment/Service
  // name, its suffix-reserving -hpa/-hcp variants (their truncation boundary sits 4
  // chars earlier), and the routing-manifest snapshot name. Refuse to deploy on any
  // collision while the build ids differ.
  // N14: an IDENTICAL build id is the `deploymentId` (skew-protection) signature — Next pins
  // the build id to a constant when next.config sets it, so every deploy reuses the serving
  // build's names and a cutover would adopt the running Deployment instead of standing up
  // beside it. The composed-name guard below can't see this case (it requires differing ids),
  // so name the cause here rather than letting helm silently upgrade in place.
  if (previousBuildId && previousBuildId === buildId) {
    throw new Error(
      `Build id "${buildId}" is IDENTICAL to the currently-serving build, so blue/green ` +
        `cutover is impossible — the new release would adopt the running Deployment in ` +
        `place, and both builds would share the \`k8s:${buildId}:\` cache namespace. The ` +
        `usual cause is \`deploymentId\` in next.config: Next then pins the build id to a ` +
        `constant for every build. Remove it — skew protection is already active via the ` +
        `per-build build id, and immutable assets already handle asset versioning — or set ` +
        `a \`generateBuildId\` that changes per build.`,
    );
  }
  if (previousBuildId && previousBuildId !== buildId) {
    // Same helper as the build-time guard in adapter.ts so both sides agree on the
    // full composed-name set (pool Deployment/Service, -hpa/-hcp variants, snapshot).
    const collision = findBuildIdNameCollision(releaseName, pools, buildId, previousBuildId);
    if (collision) {
      throw new Error(
        `Build id "${buildId}" collides with the currently-serving build "${previousBuildId}" ` +
          `after Kubernetes name sanitization: the ${collision.kind} "${collision.name}" would ` +
          `be named identically for BOTH builds (lowercasing/truncation to the 63-char name ` +
          `limit erased the difference), so the cutover could not distinguish them. Choose a ` +
          `build id that still differs within the truncated name (see generateBuildId in ` +
          `next.config), or shorten the release/pool names.`,
      );
    }
  }

  const overridesFile = path.join(projectDir, ".k8s-adapter", "helm", "values.override.yaml");
  const helmArgs = buildHelmUpgradeArgs({
    releaseName,
    chartPath: path.join(outputDir, "chart"),
    buildId,
    registry: infra.containerRegistry,
    previousBuildId,
    overridesFile,
    podCidrs: podCidr,
  });

  // Inject previous build's deployment+service into the chart so Helm doesn't delete it.
  // Without this, helm upgrade only sees the current build's templates and deletes the previous.
  if (previousBuildId && previousBuildId !== buildId) {
    const chartTemplatesDir = path.join(outputDir, "chart", "templates");
    for (const poolName of pools) {
      const poolPrevName = sanitizeK8sName(`${releaseName}-${poolName}-${previousBuildId}`);

      // The "previous" build is the one CURRENTLY SERVING traffic. Render its Deployment at
      // its current replica count — NOT 0 — so `helm upgrade` doesn't scale it to zero while
      // the active Service still selects it, which would black-hole the origin on every
      // deploy until the new pods are ready and the selector switches. It keeps serving
      // through the rollout; it is scaled to 0 only after state is committed (step 7f).
      // Default replica count: used for dry-run (no cluster read) and for a previous
      // Deployment that no longer exists (NotFound branch below).
      let prevReplicas = 2;
      if (!dryRun) {
        const r = await execCapture("kubectl", [
          "get",
          "deployment",
          poolPrevName,
          "-n",
          K8S_NAMESPACE,
          "-o",
          "jsonpath={.spec.replicas}",
        ]);
        const n = parseInt(r.stdout?.trim() ?? "", 10);
        if (r.exitCode !== 0 && isAlreadyGoneError(r.stderr)) {
          // State names a previous build whose Deployment is GONE (deleted manually /
          // cluster partially recovered). Nothing is serving from it, so there is no
          // live count to mirror — warn and render the retained manifest at the
          // default instead of aborting. Aborting here would brick every future
          // deploy of the release (the state ConfigMap keeps naming the deleted
          // build) with nothing to protect: the abort below exists for the case
          // where a live count EXISTS but could not be read.
          console.warn(
            `  ! Previous deployment ${poolPrevName} (build ${previousBuildId}) not found — ` +
              `it appears to have been deleted. Nothing is serving from it; rendering its ` +
              `retained manifest at the default ${prevReplicas} replicas.`,
          );
        } else if (r.exitCode !== 0 || !Number.isFinite(n) || n <= 0) {
          // Abort rather than guess: the probe previously defaulted to 2 on ANY failure,
          // so a serving build at 5 replicas would be silently scaled DOWN to 2 by the
          // retained manifest mid-deploy.
          throw new Error(
            `Could not read the live replica count for the currently-serving deployment ` +
              `${poolPrevName} (kubectl exited ${r.exitCode}` +
              `${r.exitCode === 0 ? `, replicas=${JSON.stringify(r.stdout?.trim())}` : `: ${r.stderr.trim()}`}). ` +
              `The retained manifest must mirror the live count; refusing to guess. Fix ` +
              `kubectl access and re-run the deploy.`,
          );
        } else {
          prevReplicas = n;
        }
      }

      // Render retained resources through the same canonical templates as a normal build.
      // Hand-copying this Deployment previously omitted resources, changing the serving pod
      // template and rolling the old build during every upgrade.
      // L13: dry-run must not write into the chart — report the planned writes instead.
      const retainedFiles: [string, string][] = [
        [
          `${poolName}-prev-deployment.yaml`,
          renderDeployment({
            poolName,
            buildId: previousBuildId,
            releaseName,
            imageTag: previousBuildId,
            replicas: prevReplicas,
          }),
        ],
        [
          `${poolName}-prev-service.yaml`,
          renderService({ poolName, buildId: previousBuildId, releaseName }),
        ],
        [
          `${poolName}-prev-hpa.yaml`,
          renderHPA({ poolName, buildId: previousBuildId, releaseName }),
        ],
      ];
      for (const [fileName, content] of retainedFiles) {
        const target = path.join(chartTemplatesDir, fileName);
        if (dryRun) {
          console.log(`    [dry-run] would write ${target}`);
        } else {
          writeFileSync(target, content);
        }
      }
    }
  }

  // 6-pre. Retain the OUTGOING build's routing manifest as a build-named snapshot
  // ConfigMap BEFORE helm overwrites the stable `<release>-routing-manifest` one — the
  // routing tier is updated in place per build, and rollback re-points it at the
  // snapshot. The snapshot keys off what the routing Deployment is ACTUALLY serving
  // (image tag + mounted ConfigMap), so it stays correct across intervening rollbacks.
  // Best-effort for transient failures (warns, does not block) — but a snapshot NAME
  // collision with a DIFFERENT build's retained manifest throws (see
  // retainLiveRoutingManifest) rather than silently clobbering the rollback target.
  if (!dryRun) {
    await retainLiveRoutingManifest(releaseName);
  }

  console.log("\n  → Running helm upgrade...");
  if (!dryRun) {
    await execOrThrow("helm", helmArgs);
  } else {
    console.log(`    [dry-run] helm ${helmArgs.join(" ")}`);
  }

  // 6b. Best-effort CDN verification: confirm the applied HTTPRoute carries the CDN filter.
  // The chart is the source of truth; this is confirmation only, never fatal.
  if (!dryRun && chartHasCdn) {
    const routeCheck = await execCapture("kubectl", [
      "get",
      "httproute",
      `${releaseName}-routes`,
      "-n",
      K8S_NAMESPACE,
      "-o",
      "jsonpath={.spec.rules[*].filters[*].extensionRef.kind}",
    ]);
    if (routeCheck.exitCode === 0 && routeCheck.stdout.includes("GCPHTTPFilter")) {
      console.log("  → Cloud CDN filter attached to HTTPRoute rules ✓");
    } else {
      console.warn(
        "  ! Could not confirm the Cloud CDN filter on the HTTPRoute (non-fatal). " +
          `Inspect with: kubectl get httproute ${releaseName}-routes -o yaml`,
      );
    }
  }

  // NOTE: committed deploy state is NOT written here. Persisting { buildId, previousBuildId }
  // before the new build actually serves would record a never-serving build as "current" —
  // a failed deploy (bad image, stuck rollout, failed cutover) would then leave state
  // pointing at a build that never took traffic, and the next deploy/rollback could delete
  // the real rollback target. State is committed only after a successful cutover (step 7d).

  // 7. Zero-downtime cutover: wait for new pods, then clean up old build
  if (!dryRun) {
    // Match the new build's pods/deployments by their EXACT version label — the same value the
    // cutover patches Services to (`sanitizeK8sName(buildId)`, which stamps `app.kubernetes.io/
    // version` on every pod). The prior match used a 12-char normalized-prefix substring, so an OLD
    // build whose id shared that prefix could satisfy this readiness check; the cutover would then
    // patch Services to the full new label, match zero pods, drain the NEG, and 503 the origin.
    const safeBuildId = sanitizeK8sName(buildId);

    // 7a. Wait for new deployment to be ready
    console.log(`\n  → Waiting for new pods to be ready...`);
    const newDeployResult = await execCapture("kubectl", [
      "get",
      "deployments",
      "-n",
      K8S_NAMESPACE,
      "-l",
      `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${safeBuildId}`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ]);
    // The routing service carries the same version label but is a stable in-place Deployment,
    // verified separately below — exclude it here by EXACT name (a substring match would
    // also exclude a pool deployment that merely contains "routing-service" in its name).
    const routingDeploy = routingServiceDeploymentName(releaseName);
    const newDeploys = (newDeployResult.stdout?.trim().split("\n") ?? []).filter(
      (n) => n && n !== routingDeploy,
    );

    for (const deployName of newDeploys) {
      console.log(`    Waiting for ${deployName}...`);
      const rollout = await execCapture("kubectl", [
        "rollout",
        "status",
        `deployment/${deployName}`,
        "-n",
        K8S_NAMESPACE,
        "--timeout=120s",
      ]);
      // The pod-health gate below is the real readiness gate, but don't walk into it on
      // an already-failed rollout — the exit code was previously discarded, so a stuck
      // deployment burned the whole 2-minute health budget before failing.
      if (rollout.exitCode !== 0) {
        throw new Error(
          `Deployment ${deployName} did not finish rolling out within 120s. Traffic was ` +
            `NOT switched — the previous build is still serving.\n` +
            `${(rollout.stderr || rollout.stdout).trim()}\n` +
            `Inspect: kubectl logs deployment/${deployName} -n ${K8S_NAMESPACE} --tail=40`,
        );
      }
    }

    // 7a-bis. The routing service (ext_proc edge) is a stable Deployment updated in place
    // per build, and was historically excluded from readiness. That let a broken image
    // (e.g. a missing @next/routing) crashloop undetected for months while Kubernetes kept
    // the old ReplicaSet serving stale edge code and the deploy reported success. Verify it
    // actually rolls out; a stuck rollout is fatal.
    const rsExists = await execCapture("kubectl", [
      "get",
      "deployment",
      routingDeploy,
      "-n",
      K8S_NAMESPACE,
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    if (rsExists.exitCode === 0 && rsExists.stdout.trim()) {
      console.log(`    Waiting for ${routingDeploy}...`);
      const rsRollout = await execCapture("kubectl", [
        "rollout",
        "status",
        `deployment/${routingDeploy}`,
        "-n",
        K8S_NAMESPACE,
        "--timeout=120s",
      ]);
      if (rsRollout.exitCode !== 0) {
        throw new Error(
          `Routing service (${routingDeploy}) did not become healthy — the ext_proc edge would ` +
            `keep serving the previous build.\n${(rsRollout.stderr || rsRollout.stdout).trim()}\n` +
            `Inspect: kubectl logs -l app.kubernetes.io/component=routing-service -n ${K8S_NAMESPACE} --tail=40`,
        );
      }
    }

    // The traffic extension is part of the middleware security boundary. Reconcile and verify
    // it while the active Services still select the previous build; never cut traffic and call
    // the deploy successful with a missing/incomplete ext_proc backend.
    const currentRouteExtJob = routeExtJobName(releaseName, buildId);
    const routeExtJobYaml = path.join(outputDir, "chart", "templates", "route-ext-update-job.yaml");
    if (existsSync(routeExtJobYaml)) {
      const wait = await execCapture("kubectl", [
        "wait",
        "--for=condition=complete",
        `job/${currentRouteExtJob}`,
        "-n",
        K8S_NAMESPACE,
        "--timeout=600s",
      ]);
      if (wait.exitCode !== 0) {
        throw new Error(
          `ext_proc registration job (${currentRouteExtJob}) did not complete; refusing traffic ` +
            `cutover because middleware may not be wired.\n${(wait.stderr || wait.stdout).trim()}\n` +
            `Inspect: kubectl logs job/${currentRouteExtJob} -n ${K8S_NAMESPACE}`,
        );
      }
      console.log("  → ext_proc traffic extension registration job completed ✓");
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
      const podsResult = await execCapture("kubectl", [
        "get",
        "pods",
        "-n",
        K8S_NAMESPACE,
        "-l",
        // The routing service shares the version label; exclude it by its component label
        // (exact — a name substring match would also drop pool pods named similarly).
        `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${safeBuildId},app.kubernetes.io/component!=routing-service`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}|{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}',
      ]);
      if (podsResult.exitCode === 0) {
        for (const line of podsResult.stdout.trim().split("\n")) {
          const [podName, ready] = line.split("|");
          if (!podName) continue; // selector already scoped to this build's pool pods
          checkedCount++;
          if (ready !== "True") allHealthy = false;
        }
      }
      if (allHealthy && checkedCount > 0) {
        console.log(`    All ${checkedCount} new pods ready and serving`);
        newBuildHealthy = true;
        break;
      }
      if (attempt < maxHealthAttempts - 1) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    if (!newBuildHealthy) {
      console.error(`\n  DEPLOY FAILED: New build did not become healthy within 2 minutes.`);
      console.error(`  The previous build is still serving traffic. No cutover performed.\n`);

      // Try to get more diagnostic info
      const newPods = await execCapture("kubectl", [
        "get",
        "pods",
        "-n",
        K8S_NAMESPACE,
        "-l",
        `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${safeBuildId},app.kubernetes.io/component!=routing-service`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}|{.status.phase}{"\\n"}{end}',
      ]);
      if (newPods.exitCode === 0 && newPods.stdout.trim()) {
        const podLines = newPods.stdout.trim().split("\n");
        for (const line of podLines) {
          const [podName, phase] = line.split("|");
          if (!podName) continue; // selector already scoped to this build's pool pods
          console.error(`  Pod ${podName}: ${phase}`);
          // Try hitting healthz directly
          const healthzResult = await execCapture("kubectl", [
            "exec",
            podName,
            "-n",
            K8S_NAMESPACE,
            "--",
            "node",
            "-e",
            `const http=require("http");http.get("http://localhost:3000/healthz",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>console.log(r.statusCode,d))}).on("error",e=>console.log("ERR",e.message))`,
          ]);
          if (healthzResult.exitCode === 0) {
            console.error(`  Healthz: ${healthzResult.stdout.trim()}`);
          }
          // Get last error from logs
          const logsResult = await execCapture("kubectl", [
            "logs",
            podName,
            "-n",
            K8S_NAMESPACE,
            "--tail=20",
          ]);
          if (logsResult.exitCode === 0) {
            const errorLines = logsResult.stdout
              .split("\n")
              .filter(
                (l) =>
                  l.includes("Error") ||
                  l.includes("error") ||
                  l.includes("FATAL") ||
                  l.includes("Cannot find"),
              );
            if (errorLines.length > 0) {
              console.error(`  Errors:`);
              for (const err of errorLines.slice(0, 5)) {
                // L14: pod log lines are cluster-sourced — strip terminal control
                // characters before printing.
                console.error(`    ${sanitizeForTerminal(err.trim()).slice(0, 150)}`);
              }
            } else {
              console.error(
                `  No errors in pod logs. The issue may be GCP health check configuration.`,
              );
            }
          }
        }
      }

      console.error(`\n  Diagnose:  npx adapter-k8s doctor`);
      console.error(`  Tail logs: npx adapter-k8s tail`);
      process.exit(1);
    }

    // 7c. Cut traffic over: patch each active Service selector to the new build.
    // MUST use the exact same sanitizer that stamped the pod labels (sanitizeK8sName,
    // which prepends `b-` when the build id starts with a non-letter). An inline
    // transform that omits the `b-` prefix writes a selector that matches no pods:
    // the Service drains to zero endpoints, its standalone NEG empties, and the LB
    // returns 503 `failed_to_connect_to_backend` for every origin request (only CDN
    // cache hits survive). This bit us on build ids beginning with a digit.
    // (safeBuildId is computed once in step 7 above and reused here.)
    console.log(`  → Switching traffic to new build...`);
    const patchFailures: { pool: string; service: string; stderr: string }[] = [];
    const patchedServices: string[] = [];
    for (const pool of pools) {
      const activeServiceName = sanitizeK8sName(`${releaseName}-${pool}`);
      const patchResult = await execCapture("kubectl", [
        "patch",
        "service",
        activeServiceName,
        "-n",
        K8S_NAMESPACE,
        "--type=json",
        // Impersonate helm as the field manager so the next helm upgrade (server-side
        // apply, manager "helm") does not conflict on the selector field we flip here.
        // NOTE: --force-conflicts is NOT a valid `kubectl patch` flag (it only exists on
        // `kubectl apply --server-side`); a JSON patch is not server-side apply and needs
        // no conflict override.
        "--field-manager=helm",
        "-p",
        JSON.stringify([
          {
            op: "replace",
            path: "/spec/selector/app.kubernetes.io~1version",
            value: safeBuildId,
          },
        ]),
      ]);
      if (patchResult.exitCode !== 0) {
        patchFailures.push({
          pool,
          service: activeServiceName,
          stderr: patchResult.stderr.trim(),
        });
      } else {
        patchedServices.push(activeServiceName);
      }
    }

    // If ANY pool's selector patch failed, some/all Services still point at the old
    // build. Deleting old deployments now would strand those Services with zero healthy
    // endpoints. Abort the cutover, leave the previous build in place, and fail loudly
    // rather than proceeding to the cleanup below and printing "Deploy complete".
    if (patchFailures.length > 0) {
      const revertFailures: string[] = [];
      if (previousBuildId) {
        const safePreviousBuildId = sanitizeK8sName(previousBuildId);
        for (const serviceName of patchedServices) {
          const revertResult = await execCapture("kubectl", [
            "patch",
            "service",
            serviceName,
            "-n",
            K8S_NAMESPACE,
            "--type=json",
            "--field-manager=helm",
            "-p",
            JSON.stringify([
              {
                op: "replace",
                path: "/spec/selector/app.kubernetes.io~1version",
                value: safePreviousBuildId,
              },
            ]),
          ]);
          if (revertResult.exitCode !== 0) revertFailures.push(serviceName);
        }
      }
      console.error(`\n  DEPLOY FAILED: traffic was NOT switched to the new build.`);
      console.error(
        `  ${patchFailures.length} of ${pools.length} pool Service selector patch(es) failed:`,
      );
      for (const f of patchFailures) {
        console.error(
          `    - pool "${f.pool}" (service ${f.service}): ${f.stderr || "unknown error"}`,
        );
      }
      if (revertFailures.length > 0) {
        console.error(
          `  WARNING: failed to restore selector(s) for: ${revertFailures.join(", ")}.`,
        );
        console.error(`  Traffic may be split across builds; repair those Services manually.`);
      } else if (previousBuildId) {
        console.error(`  Any successful selector patches were reverted to the previous build.`);
      }
      console.error(`  Old deployments were left in place.`);
      console.error(`  No cleanup was performed. Investigate and re-run the deploy.\n`);
      console.error(`  Diagnose:  npx adapter-k8s doctor`);
      // Do NOT write committed state here: traffic did not switch, so the previously-serving
      // build is still current. Recording the new build as current would strand the real
      // rollback target on the next deploy/rollback.
      process.exit(1);
    }

    // 7d. Commit deploy state IMMEDIATELY after the confirmed cutover — before anything
    // else post-switch. Every extra step between the selector patch and this write is a
    // Ctrl-C window in which traffic serves the new build while state still names the old
    // one (the next deploy/rollback would then target the wrong build). Committing ONLY
    // after a confirmed cutover still holds: a failed deploy never records a never-serving
    // build as current. Traffic has already switched; if the cluster ConfigMap write fails
    // we surface it loudly (local was updated) rather than silently diverging.
    try {
      // M13: record the exact Cache-Tag THIS build's pool-server stamps (derived HERE,
      // at its deploy — the only moment code and pods agree), and carry the outgoing
      // build's recorded tag verbatim (it stays the rollback target; re-deriving its tag
      // under newer code is exactly the M13 failure). Pruned to the two builds in play.
      const cdnTags: Record<string, string> = {};
      if (previousBuildId && state?.cdnTags?.[previousBuildId]) {
        cdnTags[previousBuildId] = state.cdnTags[previousBuildId];
      }
      cdnTags[buildId] = cdnTagForBuildId(buildId);
      await writeState(projectDir, { buildId, previousBuildId, cdnTags }, releaseName);
    } catch (err) {
      console.error(`\n  Cutover succeeded, but persisting deploy state failed:`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      console.error(
        `  The new build IS serving, but the cluster ConfigMap was not updated. Restore`,
      );
      console.error(
        `  connectivity and re-run so cluster/local state agree before the next deploy.\n`,
      );
      process.exit(1);
    }

    // 7e. State is durable. Now invalidate the PREVIOUS build's Cloud CDN entries
    // (best-effort, non-fatal; TTL self-heals) so its stale content stops serving.
    // Deliberately post-cutover — the new origin must be live before the old entries
    // are dropped — but after the state commit (7d) so a failure here can't leave
    // cluster state pointing at the outgoing build.
    const cdnFilterPath = path.join(outputDir, "chart", "templates", "cdn-http-filter.yaml");
    if (existsSync(cdnFilterPath) && infra.projectId) {
      try {
        await invalidateCdnBuildTag({
          projectId: infra.projectId,
          releaseName,
          outputDir,
          buildId: previousBuildId ?? undefined,
          // M13: the tag recorded when the OUTGOING build deployed — never re-derived
          // here. Absent (pre-recording state) → cdn-invalidate purges --path=/*.
          recordedTag: previousBuildId ? state?.cdnTags?.[previousBuildId] : undefined,
          run: execCapture,
          log: (m) => console.log(m),
        });
      } catch (err) {
        console.log(
          `  ! CDN invalidation error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 7f. State is durable and traffic has switched, so it is now safe to scale the previous
    // build down to 0. It served through the rollout and remains as the rollback target.
    // Best-effort: success is already durable (7d) — a failure here warns instead of
    // failing the whole deploy (the previous build just keeps burning replicas until the
    // next deploy or a manual scale-down).
    if (previousBuildId && previousBuildId !== buildId) {
      let scaleDownFailed = false;
      for (const poolName of pools) {
        // The HPA name must come from the SAME suffix-reserving helper the template
        // uses (hpa.ts truncates the base at 59, then appends "-hpa") — concatenating
        // "-hpa" onto the 63-truncated deployment name diverges past that boundary
        // (and can exceed 63 chars), so this delete silently missed the real HPA and
        // the autoscaler rescaled the parked previous build right back up.
        const { deployment: poolPrevName, hpa: poolPrevHpa } = poolResourceNames(
          releaseName,
          poolName,
          previousBuildId,
        );
        const hpaDelete = await execCapture("kubectl", [
          "delete",
          "hpa",
          poolPrevHpa,
          "-n",
          K8S_NAMESPACE,
          "--ignore-not-found",
        ]);
        const scaleDown = await execCapture("kubectl", [
          "scale",
          `deployment/${poolPrevName}`,
          "-n",
          K8S_NAMESPACE,
          "--replicas=0",
        ]);
        if (hpaDelete.exitCode !== 0 || scaleDown.exitCode !== 0) {
          scaleDownFailed = true;
          console.warn(
            `  ! Could not scale down ${poolPrevName}: ` +
              `${(scaleDown.stderr || hpaDelete.stderr).trim() || "unknown error"}`,
          );
        }
      }
      if (scaleDownFailed) {
        console.warn(
          `  ! Previous build ${previousBuildId} was NOT fully scaled to 0 — it keeps its ` +
            `replicas until the next deploy. Scale it down manually when convenient.`,
        );
      } else {
        console.log(`  → Previous build scaled to 0 (kept for rollback)`);
      }
    }

    // 7g. Clean up old deployments.
    // The previous build was scaled to 0 in step 7f above (kept as the rollback target).
    // Delete anything that isn't the current or previous build. Classify by EXACT deployment name
    // (reconstructed with the same sanitizer the template uses) rather than a 12-char normalized
    // substring — a shared prefix between two build ids could otherwise delete the wrong build.
    const currentDeployNames = new Set(
      pools.map((p) => sanitizeK8sName(`${releaseName}-${p}-${buildId}`)),
    );
    const previousDeployNames = previousBuildId
      ? new Set(pools.map((p) => sanitizeK8sName(`${releaseName}-${p}-${previousBuildId}`)))
      : undefined;

    const allDeploys = await execCapture("kubectl", [
      "get",
      "deployments",
      "-n",
      K8S_NAMESPACE,
      "-l",
      `app.kubernetes.io/name=${releaseName}`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ]);
    if (allDeploys.exitCode === 0) {
      for (const name of allDeploys.stdout.trim().split("\n")) {
        // The routing tier is a stable in-place Deployment — never a cleanup candidate.
        // EXACT name match: a substring match would also spare (or, elsewhere, drop) a
        // pool deployment that merely contains "routing-service" in its name.
        if (!name || name === routingDeploy) continue;
        // Keep current build
        if (currentDeployNames.has(name)) continue;
        // Keep previous build (rollback target)
        if (previousDeployNames?.has(name)) {
          console.log(`  → Previous build kept for rollback: ${name}`);
          continue;
        }
        // If we don't know the previous build, we cannot classify this non-current
        // deployment as safe to delete. Be conservative and keep it as a potential
        // rollback target rather than blanket-deleting every non-current build.
        if (!previousBuildId) {
          console.log(
            `  → Conservative cleanup: keeping non-current build "${name}" ` +
              `(previous-build state unknown, cannot classify as safe to delete)`,
          );
          continue;
        }
        // Delete everything else
        console.log(`  → Deleting old build: ${name}`);
        await execCapture("kubectl", ["delete", "deployment", name, "-n", K8S_NAMESPACE]);
        await execCapture("kubectl", ["delete", "service", name, "-n", K8S_NAMESPACE]).catch(
          () => {},
        );
        // This build's raw release/pool/buildId parts are unknowable here (`name` is a
        // cluster-listed deployment of a build state no longer tracks), so the HCP name
        // can't go through poolResourceNames. Re-sanitizing the deployment name with the
        // "-hcp" suffix reproduces the template's name exactly: for a base past the
        // 59-char boundary, re-truncating the 63-char deployment name to 59 yields the
        // same prefix the template truncated to (any trailing hyphens the template's
        // strip removed beyond 59 are re-stripped here). Bare `${name}-hcp` diverged
        // there — and could exceed 63 chars, an invalid name kubectl rejects.
        await execCapture("kubectl", [
          "delete",
          "healthcheckpolicy",
          sanitizeK8sName(name, "-hcp"),
          "-n",
          K8S_NAMESPACE,
        ]).catch(() => {});
      }
    }

    // Clean up OLD route-ext Jobs (K8s Jobs are immutable; each deploy creates a fresh
    // one). Skip the CURRENT job by EXACT name — a fuzzy build-id substring match here
    // (12-char slice vs the name's 10-char slice) previously deleted the running job
    // before it could register the extension, so the traffic ext never got reconciled.
    const oldJobs = await execCapture("kubectl", [
      "get",
      "jobs",
      "-n",
      K8S_NAMESPACE,
      "-l",
      `app.kubernetes.io/name=${releaseName},app.kubernetes.io/component=route-ext-job`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ]);
    if (oldJobs.exitCode === 0) {
      for (const jobName of oldJobs.stdout.trim().split("\n")) {
        if (!jobName || jobName === currentRouteExtJob) continue;
        await execCapture("kubectl", ["delete", "job", jobName, "-n", K8S_NAMESPACE]);
      }
    }

    // Prune retained routing-manifest snapshot ConfigMaps that belong to neither the
    // current nor the previous build. Deploy and rollback each retain one (up to ~1 MiB
    // of etcd apiece) and nothing else ever deleted them, so they accumulated
    // unboundedly. Classify by EXACT snapshot name (the same helper that named them);
    // mirror the deployment cleanup's conservatism above — with no known previous
    // build, non-current snapshots can't be classified as safe to delete, so keep them.
    // Best-effort: state is already committed (7d), a failure here only leaks storage.
    if (previousBuildId) {
      const keepSnapshots = new Set([
        routingManifestSnapshotName(releaseName, buildId),
        routingManifestSnapshotName(releaseName, previousBuildId),
      ]);
      const snapshots = await execCapture("kubectl", [
        "get",
        "configmaps",
        "-n",
        K8S_NAMESPACE,
        "-l",
        `app.kubernetes.io/name=${releaseName},app.kubernetes.io/managed-by=adapter-k8s,` +
          `app.kubernetes.io/component=routing-manifest-snapshot`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
      ]);
      if (snapshots.exitCode === 0) {
        for (const cmName of snapshots.stdout.trim().split("\n")) {
          if (!cmName || keepSnapshots.has(cmName)) continue;
          console.log(`  → Deleting old routing-manifest snapshot: ${cmName}`);
          await execCapture("kubectl", ["delete", "configmap", cmName, "-n", K8S_NAMESPACE]);
        }
      }
    }
  }

  console.log(`\n✓ Deploy complete (build: ${buildId})`);

  // 8. Run domain health checks
  if (!dryRun) {
    const { runDomainChecks } = await import("./doctor.js");
    await runDomainChecks({ projectDir, releaseName });
  }

  console.log("");
}
