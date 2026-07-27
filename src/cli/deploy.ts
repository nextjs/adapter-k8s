// src/cli/deploy.ts
import path from "node:path";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import readline from "node:readline";
import { execOrThrow, execCapture } from "./exec.js";
import { readState, writeState, StateUnavailableError, type AdapterState } from "./state.js";
import { invalidateCdnBuildTag } from "./cdn-invalidate.js";
import { cdnTagForBuildId } from "../cdn-tags.js";
import { retainLiveRoutingManifest, revertRoutingServiceToBuild } from "./rollback.js";
import { renderDeployment, POOL_READINESS_PATH } from "../emit/templates/deployment.js";

/**
 * The liveness path, used ONLY as the one-cycle fallback for the stable HealthCheckPolicy when
 * the outgoing build may predate /readyz. Deliberately spelled out here rather than imported
 * from pool-server/server.ts so the CLI does not pull the runtime server into its module graph.
 */
const LIVENESS_PATH_FOR_MIGRATION = "/healthz";
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
// N87: internal dispatch Secrets are per BUILD and annotated `helm.sh/resource-policy: keep`,
// so deploy owns both halves of their lifecycle — migrating the legacy stable-named one past
// `helm upgrade`, and pruning the ones nothing references any more.
import {
  INTERNAL_SECRET_COMPONENT,
  internalSecretName,
  legacyInternalSecretName,
} from "../emit/templates/internal-secret.js";
// Import the SAME sanitizer that stamps pod names and version labels (deployment.ts /
// service.ts). The blue/green cutover patches the active Service selector to this exact
// value, so it MUST match the pod label byte-for-byte — a divergent local copy that
// omitted the `b-` prefix drained the Service to zero endpoints and 503'd the site.
import { sanitizeK8sName } from "../emit/templates/utils.js";
import {
  assertSafeBuildId,
  assertSafePoolName as assertSafePoolNameCharset,
  assertSafeQuantity,
  assertSafeImageReference,
  findBuildIdNameCollision,
  findEmittedNameCollision,
  assertSafeImageRegistry,
  assertSafeNamespace,
  assertSafeProbePath,
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
  /**
   * N30: explicit opt-out of the fail-closed routing-manifest retention posture. Retention
   * copies the OUTGOING build's routing manifest to a build-named snapshot before
   * `helm upgrade` overwrites the stable ConfigMap; a failure permanently destroys the
   * rollback target's manifest (a rollback to it can then only revert the edge IMAGE).
   * Without this flag a retention failure aborts the deploy — same posture as
   * `--allow-no-network-policy`. When passed, the degradation is recorded in deploy state
   * so doctor can report "rollback would be image-only".
   */
  allowUnretainedManifest?: boolean;
  /**
   * N29: skip the interactive confirmation for an UNPINNED kubectl context (mirrors
   * destroy's `--yes`). Required non-interactively when infrastructure.json has no
   * projectId/region, because the whole mutating deploy then runs against whatever
   * context happens to be current.
   */
  yes?: boolean;
}

// N66: a plain URL path, the only shape safe to splice into the rendered pod spec's
// `path:` scalar. Used to vet the readiness path read back from a LIVE Deployment before
// it is mirrored into the retained manifest (renderDeployment interpolates it bare).
const LIVE_PROBE_PATH_RE = /^\/[A-Za-z0-9._~/-]{0,128}$/;

/**
 * N87. Charset gate for the live pod template's INTERNAL_HEADER_SECRET secretKeyRef name,
 * mirrored into the retained previous-build render. Same reason as LIVE_PROBE_PATH_RE: the
 * value comes from the cluster and reaches a bare YAML scalar. DNS-1123 subdomain minus dots
 * (every name this adapter emits goes through sanitizeK8sName), matching the validator the
 * template itself applies.
 */
const LIVE_SECRET_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/;

// N29: same shape as destroy's confirmation prompt (that file's copy is not exported).
function promptConfirmation(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * N20: recover the build that is ACTUALLY serving when committed deploy state cannot be
 * determined, so a transient state-read failure can never be mistaken for a first deploy
 * (which skips retained-manifest injection — `helm upgrade` then DELETES the serving
 * Deployment — and points `activeBuildId` at a build with zero ready pods).
 *
 * Ground truth is the stable active Service's `app.kubernetes.io/version` SELECTOR: that
 * is what sends traffic somewhere. Discovery is by NAME, not by the
 * `managed-by: adapter-k8s-active` label the template stamps — Helm rewrites that label
 * to `managed-by: Helm` (which is why deploy/rollback patch Services by name), the same
 * approach doctor's active-Service endpoint check uses. The selector holds the SANITIZED
 * build label, which is lossy, so the raw build id comes from the selected Deployment's
 * image TAG (the same technique rollback uses to read what the routing tier serves) and
 * is cross-checked against the label.
 *
 * Throws (never returns a guess) when the cluster cannot be read, when pools disagree, or
 * when the selected build has no Deployment.
 */
export async function discoverServingBuildId(releaseName: string): Promise<string> {
  const REPAIR =
    `Repair deploy state before deploying: run \`npx adapter-k8s doctor\`, then either ` +
    `restore .k8s-adapter/state.json or fix access to the ${releaseName}-adapter-state ` +
    `ConfigMap in namespace ${K8S_NAMESPACE}.`;

  const svcResult = await execCapture("kubectl", [
    "get",
    "svc",
    "-n",
    K8S_NAMESPACE,
    "-l",
    `app.kubernetes.io/name=${releaseName}`,
    "-o",
    "jsonpath={range .items[*]}{.metadata.name}|{.metadata.labels.app\\.kubernetes\\.io/component}|" +
      '{.spec.selector.app\\.kubernetes\\.io/version}{"\\n"}{end}',
  ]);
  if (svcResult.exitCode !== 0) {
    throw new Error(
      `Deploy state could not be determined AND the active Services could not be listed ` +
        `(kubectl exited ${svcResult.exitCode}${svcResult.stderr.trim() ? `: ${svcResult.stderr.trim()}` : ""}). ` +
        `Refusing to deploy: treating this as a first deploy would make helm delete the ` +
        `Deployment that is currently serving traffic. ${REPAIR}`,
    );
  }

  const labels = new Set<string>();
  for (const line of svcResult.stdout.trim().split("\n")) {
    const [name, component, version] = line.split("|");
    if (!name || !component || component === "routing-service") continue;
    // Keep only the STABLE active Services (`<release>-<pool>`); per-build Services
    // (`<release>-<pool>-<build>`) never receive traffic directly.
    if (name !== sanitizeK8sName(`${releaseName}-${component}`)) continue;
    if (version) labels.add(version);
  }
  if (labels.size === 0) {
    throw new Error(
      `Deploy state could not be determined and no active pool Service in namespace ` +
        `${K8S_NAMESPACE} carries an app.kubernetes.io/version selector, so the live build ` +
        `is unknown. Refusing to deploy as if this were a first deploy. ${REPAIR}`,
    );
  }
  if (labels.size > 1) {
    throw new Error(
      `Deploy state could not be determined and the active pool Services select DIFFERENT ` +
        `builds (${[...labels].join(", ")}) — traffic is already split across builds. ` +
        `Refusing to deploy on top of that. ${REPAIR}`,
    );
  }
  const label = [...labels][0]!;

  const depResult = await execCapture("kubectl", [
    "get",
    "deployments",
    "-n",
    K8S_NAMESPACE,
    "-l",
    `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${label},` +
      `app.kubernetes.io/component!=routing-service`,
    "-o",
    // The build id comes from the pod's own NEXT_BUILD_ID env, not from the image reference:
    // digest-pinned images (S7) render `<registry>/<repo>@sha256:<hex>`, so slicing after the
    // last colon yields the digest hex — per-pool images then disagree and this recovery
    // aborted on every deployment created by the normal path. The image is still read as the
    // pre-digest fallback.
    "jsonpath={range .items[*]}{.metadata.name}|{.spec.template.spec.containers[0].image}|" +
      '{range .spec.template.spec.containers[0].env[?(@.name=="NEXT_BUILD_ID")]}{.value}{end}' +
      '{"\\n"}{end}',
  ]);
  if (depResult.exitCode !== 0) {
    throw new Error(
      `Deploy state could not be determined and the Deployments for the serving build ` +
        `label "${label}" could not be listed (kubectl exited ${depResult.exitCode}` +
        `${depResult.stderr.trim() ? `: ${depResult.stderr.trim()}` : ""}). ${REPAIR}`,
    );
  }
  const tags = new Set<string>();
  for (const line of depResult.stdout.trim().split("\n")) {
    const [name, image, envBuildId] = line.split("|");
    if (!name || !image) continue;
    // Pre-digest Deployments carry `:<buildId>` and no `@sha256:`; for those the tag IS the
    // build id. A digest reference never falls back to slicing.
    const taggedBuildId =
      image.includes(":") && !image.includes("@sha256:")
        ? image.slice(image.lastIndexOf(":") + 1)
        : "";
    const buildId = envBuildId?.trim() || taggedBuildId;
    if (buildId) tags.add(buildId);
  }
  if (tags.size === 0) {
    throw new Error(
      `The active pool Service(s) select build label "${label}" but NO Deployment carries ` +
        `it (or none carries a recognizable build id), so nothing is serving from the ` +
        `selected build ` +
        `and deploy state is unreadable. The release is already broken — repair it before ` +
        `deploying. ${REPAIR}`,
    );
  }
  if (tags.size > 1) {
    throw new Error(
      `The Deployments selected by build label "${label}" carry different image tags ` +
        `(${[...tags].join(", ")}), so the live build id is ambiguous. ${REPAIR}`,
    );
  }
  const buildId = [...tags][0]!;
  // Validate at the point of consumption: this value is cluster-sourced and goes into
  // helm --set assignments, image tags, and resource names.
  assertSafeBuildId(buildId);
  if (sanitizeK8sName(buildId) !== label) {
    throw new Error(
      `The serving Deployment's build id "${buildId}" (NEXT_BUILD_ID env, or its image tag ` +
        `for a pre-digest Deployment) does not sanitize to the active ` +
        `Service selector "${label}" — the cluster is in an inconsistent state and the live ` +
        `build id cannot be trusted. ${REPAIR}`,
    );
  }
  return buildId;
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
  // N61: delegate the CHARSET to the shared validator the templates use, so deploy and
  // emit can never disagree. The local copy was `/^[a-z0-9-]+$/`, which admitted a
  // leading/trailing hyphen (an invalid K8s label value) and the YAML-1.1 boolean names
  // (`on`/`no`/`y`/`off`/`true`) the templates now reject.
  try {
    assertSafePoolNameCharset(poolName);
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)} (from build-metadata.json — ` +
        `refusing to use it in file paths.)`,
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

/**
 * S7 (SECURITY). Resolve the immutable digest of an image that was just pushed.
 *
 * Images were deployed by MUTABLE tag while the deploy identity holds registry write access —
 * and that identity is assumable by anyone who can create a Pod in the namespace (Workload
 * Identity), while the pods themselves carry INTERNAL_HEADER_SECRET and the cache credentials
 * in env. So a retag of an already-deployed build id silently changed what the pool runs on its
 * next restart or scale-up, turning pod-creation into dispatch-secret theft — and from there
 * into a cluster-wide middleware bypass. The route-ext Job's own image was digest-pinned for
 * exactly this reason; the images holding the secrets were not.
 *
 * `docker inspect` reports RepoDigests only AFTER a successful push (the digest is assigned by
 * the registry), which is why this runs here and not at chart-generation time. Returns null
 * rather than throwing: a resolvable digest is a hardening win, not a reason to fail a deploy
 * on a daemon that reports RepoDigests differently (podman/buildx shims). The caller says so.
 */
export async function resolveImageDigest(imageRef: string): Promise<string | null> {
  // ALL RepoDigests, not just index 0: they belong to the image ID, and one local image tagged
  // and pushed to more than one repository carries an entry per repository. Taking the first and
  // pairing its digest with THIS repository could reference a manifest that does not exist
  // there, leaving the new pods in ImagePullBackOff. Select the entry whose repository matches.
  const res = await execCapture("docker", [
    "inspect",
    "--format",
    "{{range .RepoDigests}}{{println .}}{{end}}",
    imageRef,
  ]);
  if (res.exitCode !== 0) return null;
  // The repository is the reference without its tag — `registry/host/repo:tag` → `…/repo`.
  // (A digest never appears here: this is the tag we just pushed.)
  const colon = imageRef.lastIndexOf(":");
  const slash = imageRef.lastIndexOf("/");
  const repository = colon > slash ? imageRef.slice(0, colon) : imageRef;
  const entries = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const at = entry.lastIndexOf("@");
    if (at === -1) continue;
    if (entry.slice(0, at) !== repository) continue;
    const digest = entry.slice(at + 1);
    if (/^sha256:[a-f0-9]{64}$/.test(digest)) return digest;
  }
  return null;
}

export function buildHelmUpgradeArgs(options: {
  releaseName: string;
  chartPath: string;
  buildId: string;
  registry: string;
  previousBuildId: string | null;
  overridesFile?: string;
  podCidrs?: string | null;
  /** S7: `<pool>` → `sha256:…`, plus the reserved key `routingService`. */
  imageDigests?: Record<string, string>;
  /**
   * Probe path for the pools' stable HealthCheckPolicy. Omitted ⇒ the chart default
   * (readiness). Set to the LIVENESS path for one cycle when the outgoing build may predate
   * /readyz — see AdapterState.readinessPathSupported.
   */
  poolHealthCheckPath?: string;
}): string[] {
  const {
    releaseName,
    chartPath,
    buildId,
    registry,
    previousBuildId,
    overridesFile,
    podCidrs,
    imageDigests,
    poolHealthCheckPath,
  } = options;
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

  if (poolHealthCheckPath !== undefined) {
    // Validated at the consumption point like every other --set value; it also lands in a bare
    // YAML scalar inside the rendered HealthCheckPolicy.
    assertSafeProbePath(poolHealthCheckPath, "poolHealthCheckPath");
    args.push("--set", `poolHealthCheckPath=${poolHealthCheckPath}`);
  }

  // S7: pin every image this deploy pushed to its immutable digest. Validated here for the
  // same reason as buildId/registry above — these land in `helm --set` assignments, and the
  // charset check is what keeps one assignment from splitting into several.
  for (const [key, digest] of Object.entries(imageDigests ?? {})) {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(
        `Invalid image digest for "${key}": ${JSON.stringify(digest)} — expected sha256:<64 hex>.`,
      );
    }
    if (key === "routingService") {
      args.push("--set", `routingService.image.digest=${digest}`);
    } else {
      assertSafePoolName(key);
      args.push("--set", `pools.${key}.image.digest=${digest}`);
    }
  }

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
  const {
    projectDir,
    releaseName,
    skipBuild,
    skipPush,
    dryRun,
    allowNoNetworkPolicy,
    allowUnretainedManifest,
    yes,
  } = options;

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
  const canPinContext = Boolean(infra.projectId && infra.region && releaseName);
  if (!dryRun && canPinContext) {
    const clusterName = `${releaseName}-cluster`;
    console.log(`\n  → Connecting to GKE cluster "${clusterName}"...`);
    await execOrThrow("gcloud", [
      "container",
      "clusters",
      "get-credentials",
      clusterName,
      "--region",
      infra.region!,
      "--project",
      infra.projectId!,
      "--quiet",
    ]);
  } else if (!canPinContext) {
    // N29: context pinning is IMPOSSIBLE (no projectId/region in infrastructure.json), so
    // EVERYTHING below — helm upgrade, the Service selector patches, the state ConfigMap
    // write — would run against whatever kubectl context happens to be current. This
    // silently-skipped get-credentials is the same hole destroy's C1 guard closed; deploy
    // had no equivalent (invariant 6). Surface the context and require confirmation.
    if (dryRun) {
      console.log(
        `  [dry-run] infrastructure.json is missing projectId/region — kubectl context ` +
          `pinning is impossible. A real deploy would target whatever kubectl context is ` +
          `current (and ask you to confirm it).`,
      );
    } else {
      const ctx = await execCapture("kubectl", ["config", "current-context"]).catch(() => null);
      // L14: the context name is kubeconfig-sourced — strip terminal control chars.
      const currentContext =
        ctx && ctx.exitCode === 0 ? sanitizeForTerminal(ctx.stdout.trim()) : "";
      console.warn(
        `\n  !!! WARNING: infrastructure.json is missing projectId/region, so kubectl could ` +
          `NOT be pinned to this release's cluster.\n` +
          `      The ENTIRE deploy (helm upgrade, Service selector cutover, deploy-state ` +
          `ConfigMap) will run against your CURRENT kubectl context:\n` +
          `      ${currentContext || "(no current context / kubectl unavailable)"}\n`,
      );
      if (!yes) {
        if (!process.stdin.isTTY) {
          throw new Error(
            "Refusing to deploy against an unpinned kubectl context non-interactively. " +
              "Restore projectId/region in .k8s-adapter/infrastructure.json (re-run " +
              "`npx adapter-k8s init`) so the context can be pinned, or re-run with --yes " +
              "only if the context above is the intended cluster.",
          );
        }
        const answer = await promptConfirmation(
          `  Type "yes" to confirm this kubectl context is the intended cluster: `,
        );
        if (answer.trim() !== "yes") {
          throw new Error(
            "Deploy aborted: the current kubectl context was not confirmed as the intended " +
              "cluster. Nothing was changed.",
          );
        }
        console.log("");
      }
    }
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
      // S8: AUTH/TLS default ON — only an explicit `false` opts out (provisionMemorystore
      // distinguishes explicit-true from defaulted-true so an existing instance is tolerated).
      ...(ms?.auth === undefined ? {} : { auth: ms.auth }),
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
  // S7: filled in after the push resolves each image to its immutable digest; empty when
  // --skip-push (nothing was pushed, so the running images are whatever is already deployed).
  const imageDigests: Record<string, string> = {};
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

    // S7: now that the registry has assigned them, resolve each pushed image to its immutable
    // digest and deploy THAT instead of the mutable `:${buildId}` tag.
    if (!dryRun) {
      const registry = infra.containerRegistry;
      const refs: Array<[string, string]> =
        containerStrategy === "shared-image"
          ? pools.map((p) => [p, `${registry}/nextjs-app:${buildId}`])
          : pools.map((p) => [p, `${registry}/nextjs-app-${p}:${buildId}`]);
      refs.push(["routingService", `${registry}/routing-service:${buildId}`]);
      const unresolved: string[] = [];
      for (const [key, ref] of refs) {
        const digest = await resolveImageDigest(ref);
        if (digest) imageDigests[key] = digest;
        else unresolved.push(ref);
      }
      if (unresolved.length > 0) {
        // Not fatal — but the operator should know the deploy is running on mutable tags,
        // because that is what makes a registry retag able to change running code.
        console.warn(
          `\n  ! Could not resolve an immutable digest for: ${unresolved.join(", ")}.\n` +
            `    These images will be deployed by TAG, so a retag of "${buildId}" would change ` +
            `what runs on the next pod start. Check that \`docker inspect\` reports RepoDigests ` +
            `for them after a push.`,
        );
      } else {
        console.log(`    Pinned ${refs.length} image(s) to immutable digests`);
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
  let state: AdapterState | null = null;
  // N20: "state is unknown" and "there is no state (first deploy)" MUST stay distinct.
  let stateUnavailable: string | null = null;
  if (dryRun) {
    state = await readState(projectDir).catch(() => null);
  } else {
    try {
      state = await readState(projectDir, releaseName);
    } catch (err) {
      if (!(err instanceof StateUnavailableError)) throw err;
      stateUnavailable = err.message;
    }
  }
  let previousBuildId = state?.buildId ?? null;
  if (stateUnavailable) {
    // Recover the live build from the cluster instead of proceeding as a first deploy
    // (which skips the retained-manifest injection below, so `helm upgrade` deletes the
    // Deployment currently serving traffic, and sets activeBuildId to a build with zero
    // ready pods). discoverServingBuildId throws with a repair message when the live
    // build can't be established — deploy must never guess here.
    console.warn(`\n  ! Committed deploy state could not be determined:\n    ${stateUnavailable}`);
    previousBuildId = await discoverServingBuildId(releaseName);
    console.warn(
      `  ! Recovered the currently-serving build "${previousBuildId}" from the active ` +
        `Service selector. Proceeding with it as the previous build — its recorded CDN tag ` +
        `is unknown, so cutover invalidation falls back to a full purge (M13). Fix deploy ` +
        `state after this deploy.`,
    );
  }
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

  // N62: collisions WITHIN a single build — pools `api` + `api-v2` with buildId `v2` both
  // emit a Deployment/Service named `<release>-api-v2` — must be caught on a FIRST deploy
  // too, so this check is unconditional (the previous-build comparison above cannot see it:
  // it needs two build ids). It runs AFTER that comparison deliberately: over the full
  // emitted name set it ALSO fires on the truncation case, and running it first masked the
  // more specific "collides with the currently-serving build" diagnosis.
  const selfCollision = findEmittedNameCollision(releaseName, pools, [buildId]);
  if (selfCollision) {
    throw new Error(
      `Emitted resource names collide within build "${buildId}": the ${selfCollision.kind} ` +
        `"${selfCollision.name}" would be applied TWICE. Either a pool is named ` +
        `"<otherPool>-${buildId}" (making its stable name equal the other pool's versioned ` +
        `name), or two names truncated to the same value at the 63-char limit. helm applies ` +
        `both objects silently, last-writer-wins, so an HTTPRoute backendRef can resolve to ` +
        `the wrong pool's pods and the cutover patches the wrong object's selector. Rename ` +
        `the pool, or shorten the release/pool names.`,
    );
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
    imageDigests,
    // First-upgrade probe migration. `helm upgrade` rewrites the stable HealthCheckPolicy
    // BEFORE the cutover, while the ACTIVE pods are still the OUTGOING build's — and a build
    // produced by an adapter from before /readyz existed answers only /healthz. Flipping the
    // load balancer to /readyz in that window can mark every serving endpoint unhealthy and
    // take the site down as a direct result of upgrading. So: keep probing /healthz for one
    // cycle whenever the recorded state does not positively say the live build serves
    // /readyz. Fresh installs (no prior state) go straight to readiness — there is no older
    // build to strand.
    ...(previousBuildId && !state?.readinessPathSupported
      ? { poolHealthCheckPath: LIVENESS_PATH_FOR_MIGRATION }
      : {}),
  });

  const chartTemplatesDir = path.join(outputDir, "chart", "templates");

  // N32: wipe any retained-manifest files from an EARLIER deploy before writing this
  // deploy's. Invariant 5 ("clean chart regeneration") only holds when a build ran: the
  // chart dir is wiped by `next build`, and these files are written AFTER it. A
  // `--skip-build` deploy therefore inherited `*-prev-*.yaml` naming a build that has
  // since been reaped, and `helm upgrade` re-applied its Deployment (a build with no
  // images, at replicas > 0).
  if (existsSync(chartTemplatesDir)) {
    let staleFiles: string[] = [];
    try {
      staleFiles = (readdirSync(chartTemplatesDir) as unknown as string[]).filter(
        (f) => typeof f === "string" && /-prev-.*\.yaml$/.test(f),
      );
    } catch {
      staleFiles = []; // unreadable chart dir — helm will fail loudly on its own
    }
    for (const fileName of staleFiles) {
      const target = path.join(chartTemplatesDir, fileName);
      if (dryRun) {
        console.log(`    [dry-run] would delete stale retained manifest ${target}`);
      } else {
        console.log(`  → Removing stale retained manifest from a previous deploy: ${fileName}`);
        try {
          unlinkSync(target);
        } catch (err) {
          throw new Error(
            `Could not delete the stale retained manifest ${target} ` +
              `(${err instanceof Error ? err.message : String(err)}). It names a build that ` +
              `may no longer exist; helm would re-apply that build's Deployment. Delete it ` +
              `by hand or re-run a full build.`,
          );
        }
      }
    }
  }

  // N64: the LIVE replica count of the build being replaced, per pool — the capacity the
  // new build must reach before it takes 100% of traffic (step 7a-ter/7b). Only populated
  // where a live count was actually read: dry-run, a new pool, and the NotFound self-heal
  // have no live capacity to match.
  const previousReplicasByPool = new Map<string, number>();

  // Inject previous build's deployment+service into the chart so Helm doesn't delete it.
  // Without this, helm upgrade only sees the current build's templates and deletes the previous.
  if (previousBuildId && previousBuildId !== buildId) {
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
      // N66: everything the retained render must reproduce from the LIVE object instead of
      // resolving from the NEW build's `.Values`. Left EMPTY for dry-run and for the
      // NotFound self-heal, where there is no live pod template to mirror and the `.Values`
      // fallback is the only option (and is the documented behavior there).
      let prevSnapshot: {
        image?: string;
        resources?: {
          cpu?: string;
          memory?: string;
          cpuLimit?: string;
          memoryLimit?: string;
          ephemeralStorage?: string;
        };
        readinessPath?: string;
        internalSecretRef?: string;
      } = {};
      if (!dryRun) {
        // N28: ONE machine-readable probe. `--ignore-not-found` makes a genuinely absent
        // Deployment exit 0 with empty stdout, and the name field distinguishes "absent"
        // from "present with an unreadable replica count". The previous version keyed off
        // `isAlreadyGoneError(stderr)`, which matches a bare "404"/"no such" ANYWHERE in
        // stderr — so any proxy/auth/wrong-project error whose text contains 404 took the
        // lenient branch and scaled a build serving N≫2 down to 2 mid-deploy, the exact
        // regression the abort below was added to prevent.
        const r = await execCapture("kubectl", [
          "get",
          "deployment",
          poolPrevName,
          "-n",
          K8S_NAMESPACE,
          "--ignore-not-found",
          "-o",
          // N66: one probe, one round trip — every field the retained manifest must
          // reproduce byte-for-byte. `ephemeral-storage` needs the bracket form (a hyphen
          // is not a legal dotted jsonpath segment).
          "jsonpath={.metadata.name}|{.spec.replicas}" +
            "|{.spec.template.spec.containers[0].image}" +
            "|{.spec.template.spec.containers[0].resources.requests.cpu}" +
            "|{.spec.template.spec.containers[0].resources.requests.memory}" +
            "|{.spec.template.spec.containers[0].resources.requests['ephemeral-storage']}" +
            "|{.spec.template.spec.containers[0].resources.limits.cpu}" +
            "|{.spec.template.spec.containers[0].resources.limits.memory}" +
            "|{.spec.template.spec.containers[0].readinessProbe.httpGet.path}|" +
            // N87: WHICH internal dispatch Secret the live pod template resolves. Per-build
            // now, but a build deployed by an older adapter references the legacy stable name
            // — re-rendering it with the derived name would repoint the SERVING build's pods
            // at a Secret nobody rendered. The `range` form tolerates a container with no such
            // env (an even older build) instead of failing the whole jsonpath.
            '{range .spec.template.spec.containers[0].env[?(@.name=="INTERNAL_HEADER_SECRET")]}' +
            "{.valueFrom.secretKeyRef.name}{end}",
        ]);
        if (r.exitCode !== 0) {
          // Abort rather than guess: the probe previously defaulted to 2 on ANY failure,
          // so a serving build at 5 replicas would be silently scaled DOWN to 2 by the
          // retained manifest mid-deploy.
          throw new Error(
            `Could not read the live replica count for the currently-serving deployment ` +
              `${poolPrevName} (kubectl exited ${r.exitCode}: ${r.stderr.trim()}). ` +
              `The retained manifest must mirror the live count; refusing to guess. Fix ` +
              `kubectl access and re-run the deploy.`,
          );
        }
        const [
          foundName,
          replicasField,
          imageField,
          cpuReqField,
          memReqField,
          ephReqField,
          cpuLimField,
          memLimField,
          readinessPathField,
          internalSecretRefField,
        ] = r.stdout.trim().split("|");
        if (!foundName) {
          // N31: no Deployment for this pool in the previous build. Two very different
          // causes — tell them apart by whether the pool's STABLE active Service exists
          // (helm creates it with the pool; it outlives individual builds):
          //   * Service exists  → the pool existed before and its previous Deployment was
          //     deleted (manually / partial cluster recovery). Keep the historical
          //     self-heal: warn and render the retained manifest at the default, rather
          //     than bricking every future deploy of the release.
          //   * Service absent  → the pool is NEW in this build, so there is nothing to
          //     retain. Rendering anything here fabricated a previous-build Deployment
          //     with `imageTag: previousBuildId` — a tag that was never built — giving the
          //     whole deploy an ImagePullBackOff (step 7a only waits on the new build's
          //     label) and turning the next rollback's clean "Previous deployment missing"
          //     abort into a 120 s timeout.
          const activeServiceName = sanitizeK8sName(`${releaseName}-${poolName}`);
          const svc = await execCapture("kubectl", [
            "get",
            "service",
            activeServiceName,
            "-n",
            K8S_NAMESPACE,
            "--ignore-not-found",
            "-o",
            "name",
          ]);
          if (svc.exitCode !== 0) {
            throw new Error(
              `Could not determine whether pool "${poolName}" existed in the previous build ` +
                `${previousBuildId}: neither its Deployment (${poolPrevName}) nor its active ` +
                `Service (${activeServiceName}) could be read (kubectl exited ` +
                `${svc.exitCode}: ${svc.stderr.trim()}). Refusing to guess — retaining a ` +
                `manifest for a pool that never existed renders an image tag that was never ` +
                `built. Fix kubectl access and re-run the deploy.`,
            );
          }
          if (!svc.stdout.trim()) {
            console.log(
              `  → Pool "${poolName}" is new in this build (no active Service ` +
                `${activeServiceName}) — nothing to retain for build ${previousBuildId}.`,
            );
            continue;
          }
          console.warn(
            `  ! Previous deployment ${poolPrevName} (build ${previousBuildId}) not found — ` +
              `it appears to have been deleted. Nothing is serving from it; rendering its ` +
              `retained manifest at the default ${prevReplicas} replicas.`,
          );
        } else {
          const n = parseInt(replicasField ?? "", 10);
          if (!Number.isFinite(n) || n <= 0) {
            throw new Error(
              `Could not read the live replica count for the currently-serving deployment ` +
                `${poolPrevName} (replicas=${JSON.stringify(replicasField ?? "")}). ` +
                `The retained manifest must mirror the live count; refusing to guess. Fix ` +
                `kubectl access and re-run the deploy.`,
            );
          }
          prevReplicas = n;
          previousReplicasByPool.set(poolName, n);
          // N66: snapshot the live container spec. A field the live object does not carry
          // (an older build predating ephemeral-storage, say) is simply omitted, which
          // leaves that ONE field on the `.Values` fallback rather than inventing a value —
          // omitting it is what the running object has, so the render still matches.
          // Every literal is cluster-sourced and lands in the rendered pod spec, so it is
          // validated HERE, at the point of consumption (AGENTS.md), not only inside the
          // template: a value that fails validation aborts the deploy rather than being
          // dropped (silently reverting that field to the new build's values would
          // reintroduce exactly the skew this snapshot exists to prevent).
          if (imageField) {
            assertSafeImageReference(imageField);
          }
          const liveQuantity = (value: string, field: string): string => {
            assertSafeQuantity(value, `live ${poolPrevName} ${field}`);
            return value;
          };
          prevSnapshot = {
            ...(imageField ? { image: imageField } : {}),
            resources: {
              ...(cpuReqField ? { cpu: liveQuantity(cpuReqField, "requests.cpu") } : {}),
              ...(memReqField ? { memory: liveQuantity(memReqField, "requests.memory") } : {}),
              ...(ephReqField
                ? { ephemeralStorage: liveQuantity(ephReqField, "requests.ephemeral-storage") }
                : {}),
              ...(cpuLimField ? { cpuLimit: liveQuantity(cpuLimField, "limits.cpu") } : {}),
              ...(memLimField ? { memoryLimit: liveQuantity(memLimField, "limits.memory") } : {}),
            },
            // N66: the readiness PATH is part of "what is running" too. The retained build
            // may predate the pool server's `/readyz` endpoint, and stamping the current
            // default onto it would change the SERVING build's pod template into a probe
            // its pods cannot satisfy (a stalled RollingUpdate on the build carrying 100%
            // of traffic). `renderDeployment` interpolates this as a BARE YAML scalar with
            // no validation of its own, so a cluster-sourced value must be charset-checked
            // here; anything unexpected falls back to the template default.
            ...(readinessPathField && LIVE_PROBE_PATH_RE.test(readinessPathField)
              ? { readinessPath: readinessPathField }
              : {}),
            // N87: mirror the live secretKeyRef. Cluster-sourced and spliced into a bare YAML
            // scalar, so it is charset-checked here; anything unexpected falls back to the
            // derived per-build name rather than aborting the deploy (same posture as the
            // readiness path above).
            ...(internalSecretRefField && LIVE_SECRET_NAME_RE.test(internalSecretRefField)
              ? { internalSecretRef: internalSecretRefField }
              : {}),
          };
          if (internalSecretRefField && !LIVE_SECRET_NAME_RE.test(internalSecretRefField)) {
            console.warn(
              `  ! Live INTERNAL_HEADER_SECRET secretKeyRef ${JSON.stringify(
                internalSecretRefField,
              )} on ${poolPrevName} is not a plain Secret name — the retained manifest will use ` +
                `the per-build default instead of mirroring it.`,
            );
          }
          if (readinessPathField && !LIVE_PROBE_PATH_RE.test(readinessPathField)) {
            console.warn(
              `  ! Live readiness path ${JSON.stringify(readinessPathField)} on ` +
                `${poolPrevName} is not a plain URL path — the retained manifest will use ` +
                `the template default instead of mirroring it.`,
            );
          }
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
            // N66: literals win over the `.Values` expressions, so changing `resources` in
            // next.config — or flipping `containerStrategy`, which repoints the repository
            // at `nextjs-app-<pool>` vs `nextjs-app` — cannot mutate (and therefore roll)
            // the pod template of the build still serving 100% of traffic. Flipping
            // containerStrategy previously pointed the retained manifest at a tag that was
            // never pushed: ImagePullBackOff on the SERVING build, before cutover.
            ...prevSnapshot,
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
  // N30: a retention FAILURE is fatal by default. It used to print one warning and
  // proceed, permanently destroying the rollback target's routing manifest (helm then
  // overwrites the stable ConfigMap), so a rollback to the outgoing build could only
  // revert the edge IMAGE — silently, with the degradation recorded nowhere.
  let unretainedManifestBuild: string | null = null;
  if (!dryRun) {
    const retention = await retainLiveRoutingManifest(releaseName);
    if (retention.status === "failed") {
      if (!allowUnretainedManifest) {
        throw new Error(
          `Could not retain the outgoing build's routing manifest: ${retention.reason}\n` +
            `Aborting BEFORE helm upgrade — helm overwrites the stable ` +
            `<release>-routing-manifest ConfigMap, so proceeding would permanently destroy ` +
            `the rollback target's manifest and a rollback could only revert the edge image. ` +
            `Nothing was changed. Fix cluster access and re-run, or pass ` +
            `--allow-unretained-manifest to deploy with an image-only rollback path.`,
        );
      }
      unretainedManifestBuild = previousBuildId;
      console.warn(
        `  ! Proceeding WITHOUT a retained routing manifest for the outgoing build ` +
          `(--allow-unretained-manifest): ${retention.reason}. A rollback to ` +
          `${previousBuildId ?? "the previous build"} will revert the routing IMAGE only; ` +
          `the edge keeps this build's routing manifest and mismatched routes fall back to ` +
          `pool-local re-resolution (invariant 1).`,
      );
    }
  }

  // 6-pre-bis (N87). Preserve the LEGACY stable-named internal dispatch Secret across this
  // upgrade. Internal secrets are now per-BUILD (`<release>-ihs-<build>-<digest>`,
  // emit/templates/internal-secret.ts), so the first upgrade under that scheme removes
  // `<release>-internal-header-secret` from the chart — and helm prunes what the chart no
  // longer renders. The build being REPLACED still references that name in its pod template:
  // pruning it would leave the rollback target unable to start a single pod
  // (CreateContainerConfigError on a missing secretKeyRef), and would do the same to any
  // outgoing pod that restarts inside this deploy window — while it is still carrying 100% of
  // traffic. `helm.sh/resource-policy: keep` on the LIVE object is what helm checks, so
  // annotating it here is enough; the sweep in step 7g deletes it once no Deployment
  // references it. A READ failure is not "absent" (the N68 lesson): nothing has been changed
  // yet at this point, so abort cleanly rather than upgrade over an unknown.
  {
    const legacySecret = legacyInternalSecretName(releaseName);
    const keepAnnotation = "helm.sh/resource-policy=keep";
    if (dryRun) {
      console.log(
        `    [dry-run] kubectl annotate secret ${legacySecret} -n ${K8S_NAMESPACE} ` +
          `${keepAnnotation} --overwrite (if it exists)`,
      );
    } else {
      const found = await execCapture("kubectl", [
        "get",
        "secret",
        legacySecret,
        "-n",
        K8S_NAMESPACE,
        "--ignore-not-found",
        "-o",
        "name",
      ]);
      if (found.exitCode !== 0) {
        throw new Error(
          `Could not determine whether the legacy internal dispatch Secret ${legacySecret} ` +
            `exists (kubectl exited ${found.exitCode}: ${found.stderr.trim()}). ` +
            `--ignore-not-found makes a genuinely absent Secret exit 0, so this is a ` +
            `connectivity/RBAC failure. Refusing to run \`helm upgrade\`: if that Secret DOES ` +
            `exist, helm would prune it and the build it belongs to could no longer start a ` +
            `pod — bricking the rollback target. Nothing was changed; fix kubectl access and ` +
            `re-run.`,
        );
      }
      if (found.stdout.trim()) {
        const annotated = await execCapture("kubectl", [
          "annotate",
          "secret",
          legacySecret,
          "-n",
          K8S_NAMESPACE,
          keepAnnotation,
          "--overwrite",
        ]);
        if (annotated.exitCode !== 0) {
          throw new Error(
            `Could not annotate the legacy internal dispatch Secret ${legacySecret} with ` +
              `helm.sh/resource-policy=keep (kubectl exited ${annotated.exitCode}: ` +
              `${annotated.stderr.trim()}). \`helm upgrade\` would prune it, leaving the ` +
              `outgoing build unable to start a pod (its pod template references that Secret ` +
              `by name) — so both a restart inside this deploy window and a rollback to it ` +
              `would fail. Nothing was changed; fix kubectl access and re-run.`,
          );
        }
        // Says "legacy", not "the outgoing build's": this step runs on EVERY deploy while that
        // Secret exists, and after the first migration the outgoing build is already on a
        // per-build name — so the Secret being annotated here belongs to some OLDER build still
        // retained. Nothing is leaked by re-annotating; step 7g deletes it once no Deployment
        // references it, and that is the line to look for.
        console.log(`  → Preserved the legacy internal dispatch Secret (${legacySecret})`);
      }
    }
  }

  console.log("\n  → Running helm upgrade...");
  // N25: from here on, the ext_proc edge runs the NEW build — helm overwrites the stable
  // `<release>-routing-manifest` ConfigMap the routing Deployment mounts BY NAME, and
  // kubelet volume sync propagates it even to routing pods that never rolled. Every abort
  // below must therefore put the edge back on the previous build (rollback has the
  // symmetric roll-forward; deploy had none) and say what state the edge is in.
  let helmApplied = false;
  if (!dryRun) {
    await execOrThrow("helm", helmArgs);
    helmApplied = true;
  } else {
    console.log(`    [dry-run] helm ${helmArgs.join(" ")}`);
  }

  /**
   * N25: re-point the routing tier (image + retained manifest snapshot) at the previous
   * build after a post-`helm upgrade` abort, so the edge and the pools agree on which
   * build is live. Returns what actually happened so the abort message can be accurate
   * instead of asserting "no cutover performed" while the edge serves the new build.
   */
  const restoreEdgeToPreviousBuild = async (): Promise<{
    attempted: boolean;
    restored: boolean;
    error: string;
  }> => {
    if (!helmApplied || !previousBuildId || previousBuildId === buildId) {
      return { attempted: false, restored: false, error: "" };
    }
    try {
      await revertRoutingServiceToBuild({
        releaseName,
        targetBuildId: previousBuildId,
        registry: infra.containerRegistry,
        targetImageDigest: state?.routingImageDigests?.[previousBuildId],
      });
      return { attempted: true, restored: true, error: "" };
    } catch (err) {
      return {
        attempted: true,
        restored: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  // Human-readable tail for an abort message, describing the edge's ACTUAL state.
  const edgeStatusLines = (r: {
    attempted: boolean;
    restored: boolean;
    error: string;
  }): string[] => {
    if (!r.attempted) return [];
    if (r.restored) {
      return [
        `  The routing edge (ext_proc: image + routing manifest) was reverted to build ` +
          `${previousBuildId}, so edge and pools are consistent.`,
      ];
    }
    return [
      `  WARNING: could not revert the routing edge to build ${previousBuildId}: ` +
        `${r.error || "unknown error"}`,
      `  The edge (ext_proc) is running build ${buildId}'s middleware and routing manifest ` +
        `while the pools serve ${previousBuildId}. Mismatched routes fall back to pool-local ` +
        `re-resolution (invariant 1), but edge middleware is the NEW build's until repaired:`,
      `    kubectl -n ${K8S_NAMESPACE} set image deployment/` +
        `${routingServiceDeploymentName(releaseName)} routing-service=` +
        `${infra.containerRegistry}/routing-service:${previousBuildId}`,
    ];
  };

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
        // N25: the edge already runs the new build (helm overwrote the stable manifest
        // ConfigMap) — put it back before claiming the previous build is still serving.
        const edge = await restoreEdgeToPreviousBuild();
        throw new Error(
          [
            `Deployment ${deployName} did not finish rolling out within 120s. Traffic was ` +
              `NOT switched — the previous build's pools are still serving.`,
            `${(rollout.stderr || rollout.stdout).trim()}`,
            `Inspect: kubectl logs deployment/${deployName} -n ${K8S_NAMESPACE} --tail=40`,
            ...edgeStatusLines(edge),
          ].join("\n"),
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
        // The new routing pods can't roll — but the OLD routing pods already picked up the
        // new build's manifest from the (helm-overwritten) stable ConfigMap via kubelet
        // volume sync, so the edge is on the new build regardless. Revert it (N25).
        const edge = await restoreEdgeToPreviousBuild();
        throw new Error(
          [
            `Routing service (${routingDeploy}) did not become healthy. Traffic was NOT ` +
              `switched — the previous build's pools are still serving.`,
            `${(rsRollout.stderr || rsRollout.stdout).trim()}`,
            `Inspect: kubectl logs -l app.kubernetes.io/component=routing-service -n ${K8S_NAMESPACE} --tail=40`,
            ...edgeStatusLines(edge),
          ].join("\n"),
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
        const edge = await restoreEdgeToPreviousBuild();
        throw new Error(
          [
            `ext_proc registration job (${currentRouteExtJob}) did not complete; refusing ` +
              `traffic cutover because middleware may not be wired.`,
            `${(wait.stderr || wait.stdout).trim()}`,
            `Inspect: kubectl logs job/${currentRouteExtJob} -n ${K8S_NAMESPACE}`,
            ...edgeStatusLines(edge),
          ].join("\n"),
        );
      }
      console.log("  → ext_proc traffic extension registration job completed ✓");
    }

    // 7a-ter. N64: match the outgoing build's CAPACITY before the gate below can pass.
    // The chart renders a new build at its HPA floor (`replicas.min`), while the build
    // being replaced may be sitting far above that after autoscaling under load. Cutting
    // over then hands 100% of traffic to `min` pods with the HPA climbing from behind —
    // and the gate cannot simply WAIT for the higher count, because with no traffic yet
    // nothing would ever scale the new build up. So ask for the capacity explicitly here;
    // the HPA takes over from real load once traffic arrives, and the next helm upgrade
    // re-renders the floor.
    //
    // N67: `helm upgrade` above ALSO installed the new build's own HPA
    // (`<release>-<pool>-<build>-hpa`) with the chart's `replicas.min`/`replicas.max`. When
    // the outgoing build sits ABOVE the new chart's `max` — it autoscaled under load, or a
    // rollback widened it (N26), or the operator lowered the ceiling — the autoscaler
    // reconciles the manual scale below straight back down within one control loop, and the
    // gate at 7b then waits for a count that can NEVER be reached: the deploy burned the
    // whole health budget and aborted BEFORE cutover, i.e. the capacity gate blocked every
    // such deploy. So raise the ceiling for the warm-up, remember the chart-rendered value,
    // and put it back on EVERY exit path (success AND abort) — an aborted deploy must not
    // leave a widened autoscaler behind on the build it abandoned.
    //
    // Only `maxReplicas` is touched. `minReplicas` cannot undo the scale-up inside this
    // window: HPA scale-DOWN is gated by `behavior.scaleDown.stabilizationWindowSeconds`
    // (300s by default) while the gate below is bounded at 120s, so widening the floor too
    // would be a second mutation to restore for no reachability gain — and after cutover
    // real load, under the chart's own bounds, is exactly what should decide the count.
    const widenedHpas: { name: string; max: number }[] = [];
    let widenedHpasRestored = false;
    const restoreWidenedHpas = async (): Promise<void> => {
      if (widenedHpasRestored) return;
      widenedHpasRestored = true; // idempotent: every exit path calls this
      for (const { name, max } of widenedHpas) {
        const restore = await execCapture("kubectl", [
          "patch",
          "hpa",
          name,
          "-n",
          K8S_NAMESPACE,
          "--type=merge",
          // Same field-manager rationale as the Service/Deployment patches: helm owns the
          // chart-rendered HPA, so the next `helm upgrade` must not conflict here.
          "--field-manager=helm",
          "-p",
          JSON.stringify({ spec: { maxReplicas: max } }),
        ]);
        if (restore.exitCode === 0) {
          console.log(`  → Restored ${name} to the chart's maxReplicas=${max}`);
        } else {
          console.warn(
            `  ! Could not restore ${name} to the chart's maxReplicas=${max} ` +
              `(${restore.stderr.trim() || `exit ${restore.exitCode}`}) — it is STILL widened ` +
              `for the pre-cutover warm-up, so this pool may autoscale above its configured ` +
              `ceiling until the next \`helm upgrade\` re-renders it. Fix it with: kubectl -n ` +
              `${K8S_NAMESPACE} patch hpa ${name} --type=merge -p ` +
              `'{"spec":{"maxReplicas":${max}}}'`,
          );
        }
      }
    };

    // N67: the per-pool count the gate at 7b requires. Starts at the outgoing build's live
    // count and is only ever LOWERED — to a ceiling we could not raise, because asking for
    // more than the autoscaler permits is unreachable by construction.
    const capacityTargets = new Map(previousReplicasByPool);

    const shortfalls: string[] = [];
    for (const [poolName, outgoing] of previousReplicasByPool) {
      const { deployment: newDeployName, hpa: newHpaName } = poolResourceNames(
        releaseName,
        poolName,
        buildId,
      );

      // N67: machine-readable HPA probe — `--ignore-not-found` makes a genuinely absent
      // HPA (autoscaling disabled for the pool) exit 0 with empty stdout, so a non-zero
      // exit is a real read failure and the name field tells the two apart.
      const hpaRead = await execCapture("kubectl", [
        "get",
        "hpa",
        newHpaName,
        "-n",
        K8S_NAMESPACE,
        "--ignore-not-found",
        "-o",
        "jsonpath={.metadata.name}|{.spec.minReplicas}|{.spec.maxReplicas}",
      ]);
      if (hpaRead.exitCode !== 0) {
        console.warn(
          `  ! Could not read the new build's HPA ${newHpaName} (kubectl exited ` +
            `${hpaRead.exitCode}${hpaRead.stderr.trim() ? `: ${hpaRead.stderr.trim()}` : ""}) — ` +
            `if its maxReplicas is below ${outgoing} it will undo the scale-up below and the ` +
            `capacity gate cannot be satisfied.`,
        );
      } else {
        const [hpaFound, hpaMinField, hpaMaxField] = hpaRead.stdout.trim().split("|");
        const hpaMin = parseInt(hpaMinField ?? "", 10);
        const hpaMax = parseInt(hpaMaxField ?? "", 10);
        if (hpaFound && Number.isFinite(hpaMax) && hpaMax < outgoing) {
          // maxReplicas must stay >= minReplicas (the API server rejects otherwise); an
          // unset minReplicas defaults to 1, which is also what the chart renders.
          const widened = Math.max(outgoing, Number.isFinite(hpaMin) ? hpaMin : 1);
          console.log(
            `  → Widening ${newHpaName} maxReplicas ${hpaMax} → ${widened} so the warm-up to ` +
              `the outgoing build's ${outgoing} replicas is not autoscaled back down ` +
              `(restored to ${hpaMax} after cutover)`,
          );
          const widen = await execCapture("kubectl", [
            "patch",
            "hpa",
            newHpaName,
            "-n",
            K8S_NAMESPACE,
            "--type=merge",
            "--field-manager=helm",
            "-p",
            JSON.stringify({ spec: { maxReplicas: widened } }),
          ]);
          if (widen.exitCode === 0) {
            widenedHpas.push({ name: newHpaName, max: hpaMax });
          } else {
            // The ceiling stands, so asking the gate for more than it allows would hang the
            // deploy until the health budget expired and then abort — a deploy-blocking
            // failure for a pool that simply cannot exceed its configured maximum. Lower
            // the target to what the autoscaler permits and say so.
            capacityTargets.set(poolName, hpaMax);
            console.warn(
              `  ! Could not widen ${newHpaName} to maxReplicas=${widened} ` +
                `(${widen.stderr.trim() || `exit ${widen.exitCode}`}). That HPA caps pool ` +
                `"${poolName}" at ${hpaMax} replicas, below the outgoing build's ${outgoing} — ` +
                `cutting over at ${hpaMax} (the configured ceiling, the most this pool can ` +
                `ever run under this chart) instead of waiting for a count the autoscaler ` +
                `forbids. Raise pools.${poolName}.replicas.max in adapter config if the ` +
                `outgoing capacity is what this pool actually needs.`,
            );
          }
        }
      }

      const expected = capacityTargets.get(poolName) ?? outgoing;
      const cur = await execCapture("kubectl", [
        "get",
        "deployment",
        newDeployName,
        "-n",
        K8S_NAMESPACE,
        "--ignore-not-found",
        "-o",
        "jsonpath={.metadata.name}|{.spec.replicas}",
      ]);
      const [foundName, replicasField] = cur.stdout.trim().split("|");
      const current = parseInt(replicasField ?? "", 10);
      if (cur.exitCode !== 0 || !foundName || !Number.isFinite(current)) {
        // Don't abort here — the readiness gate below is the authority and will fail
        // closed if the capacity never materializes. Say why we could not pre-scale.
        console.warn(
          `  ! Could not read the new build's replica count for ${newDeployName} ` +
            `(kubectl exited ${cur.exitCode}${cur.stderr.trim() ? `: ${cur.stderr.trim()}` : ""}) ` +
            `— skipping the pre-cutover scale-up to the outgoing build's ${expected} replicas.`,
        );
        continue;
      }
      if (current >= expected) continue;
      console.log(
        `  → Matching outgoing capacity for pool "${poolName}": scaling ${newDeployName} ` +
          `${current} → ${expected} replicas before cutover`,
      );
      const scaleUp = await execCapture("kubectl", [
        "scale",
        `deployment/${newDeployName}`,
        "-n",
        K8S_NAMESPACE,
        `--replicas=${expected}`,
      ]);
      if (scaleUp.exitCode !== 0) {
        shortfalls.push(
          `${newDeployName}: could not scale to ${expected} ` +
            `(${scaleUp.stderr.trim() || `exit ${scaleUp.exitCode}`})`,
        );
      }
    }
    if (shortfalls.length > 0) {
      // Not fatal on its own: the gate below requires readyReplicas >= the outgoing count
      // per pool, so an unfulfilled scale-up aborts the cutover there with full context.
      for (const s of shortfalls) console.warn(`  ! ${s}`);
    }

    // 7b. Wait for the new build's pods to be READY from inside the cluster.
    // This reads each pod's `Ready` condition — which the kubelet drives from the
    // readinessProbe, and that probe now targets `/readyz` (N32), a 503-until-serving
    // endpoint (instrumentation registered, at least one route module loaded) rather than
    // the hardcoded-200 `/healthz` that could not fail. GCP LB backend health is
    // deliberately NOT waited on here: backend propagation can take 5+ minutes for a new
    // backend, and the NEG health checks gate the endpoints independently after the flip.
    //
    // N64: readiness of SOME pods is not enough — the gate requires at least as many ready
    // pods per pool as the build being replaced is running (previousReplicasByPool). It
    // used to pass on `checkedCount > 0`, i.e. ONE ready pod, so a previous build serving 6
    // cut over to a single pod.
    console.log(`  → Verifying new pods are serving...`);
    let newBuildHealthy = false;
    let lastShortfall = "";
    const maxHealthAttempts = 24; // 2 minutes (5s intervals)
    for (let attempt = 0; attempt < maxHealthAttempts; attempt++) {
      let allHealthy = true;
      let checkedCount = 0;
      const readyByPool = new Map<string, number>();
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
        // The component label IS the pool name (deployment.ts stamps it), which is what
        // makes the per-pool count below exact without parsing pod names.
        'jsonpath={range .items[*]}{.metadata.name}|{.status.conditions[?(@.type=="Ready")].status}|{.metadata.labels.app\\.kubernetes\\.io/component}{"\\n"}{end}',
      ]);
      if (podsResult.exitCode === 0) {
        for (const line of podsResult.stdout.trim().split("\n")) {
          const [podName, ready, component] = line.split("|");
          if (!podName) continue; // selector already scoped to this build's pool pods
          checkedCount++;
          if (ready !== "True") {
            allHealthy = false;
            continue;
          }
          if (component) readyByPool.set(component, (readyByPool.get(component) ?? 0) + 1);
        }
      }
      // Per-pool capacity check against the build being replaced (N67: against the
      // possibly-lowered target, so an autoscaler ceiling we could not raise aborts the
      // deploy here only when the pods really are short of that ceiling).
      const missing: string[] = [];
      for (const [poolName, expected] of capacityTargets) {
        const ready = readyByPool.get(poolName) ?? 0;
        if (ready < expected) missing.push(`${poolName}: ${ready}/${expected} ready`);
      }
      lastShortfall = missing.join(", ");
      if (allHealthy && checkedCount > 0 && missing.length === 0) {
        console.log(`    All ${checkedCount} new pods ready and serving`);
        newBuildHealthy = true;
        break;
      }
      if (attempt < maxHealthAttempts - 1) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    if (!newBuildHealthy) {
      // N25 before anything else: the ext_proc edge has been on the new build since
      // `helm upgrade` (stable manifest ConfigMap + in-place routing Deployment), so
      // "no cutover performed" was only ever true of the POOLS.
      const edge = await restoreEdgeToPreviousBuild();
      // N67: and the warm-up widening goes back before we leave — this build is being
      // abandoned, so it must not keep the right to autoscale past its chart ceiling.
      await restoreWidenedHpas();
      console.error(`\n  DEPLOY FAILED: New build did not become healthy within 2 minutes.`);
      console.error(
        `  The previous build's pools are still serving traffic. No pool cutover was performed.`,
      );
      for (const line of edgeStatusLines(edge)) console.error(line);
      if (lastShortfall) {
        // N64: distinguish "pods aren't ready" from "not ENOUGH pods are ready" — the
        // latter is a capacity gate, and the numbers say which pool fell short of the
        // outgoing build's live count.
        console.error(
          `  Capacity gate: the new build must match the outgoing build's live replica ` +
            `count per pool before cutover — ${lastShortfall}.`,
        );
      }
      console.error("");

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
          // N32: probe the READINESS endpoint, not `/healthz`. `/healthz` returns a
          // hardcoded 200 before any routing or handler load — it cannot fail, so asking it
          // here told the operator nothing at exactly the moment they need something.
          // `/readyz` 503s until the pod can actually serve and its body carries a `reason`
          // ("instrumentation register() failed", "route module /x failed to load"), which
          // is the answer to "why is this pod not Ready?" — so print the body too.
          const readyzResult = await execCapture("kubectl", [
            "exec",
            podName,
            "-n",
            K8S_NAMESPACE,
            "--",
            "node",
            "-e",
            `const http=require("http");http.get("http://localhost:3000${POOL_READINESS_PATH}",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>console.log(r.statusCode,d))}).on("error",e=>console.log("ERR",e.message))`,
          ]);
          if (readyzResult.exitCode === 0 && readyzResult.stdout.trim()) {
            // L14: the body is pod-sourced text — strip terminal control characters.
            console.error(
              `  Readiness (${POOL_READINESS_PATH}): ` +
                `${sanitizeForTerminal(readyzResult.stdout.trim()).slice(0, 300)}`,
            );
          } else if (readyzResult.exitCode !== 0) {
            console.error(
              `  Readiness (${POOL_READINESS_PATH}): probe could not run ` +
                `(kubectl exec exited ${readyzResult.exitCode}) — the container may not be ` +
                `running yet; see the pod logs below.`,
            );
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
      // N25: the pools stay on the previous build, so the edge must too.
      const edge = await restoreEdgeToPreviousBuild();
      // N67: restore the chart's autoscaling ceiling on the build we are abandoning.
      await restoreWidenedHpas();
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
      for (const line of edgeStatusLines(edge)) console.error(line);
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
      const recordedPrevTag = previousBuildId ? state?.cdnTags?.[previousBuildId] : undefined;
      if (previousBuildId && recordedPrevTag) {
        cdnTags[previousBuildId] = recordedPrevTag;
      }
      cdnTags[buildId] = cdnTagForBuildId(buildId);
      // Same shape and pruning as cdnTags: keep the two builds still in play, so a rollback
      // to either can pin the routing image by digest instead of reconstructing a tag.
      const routingImageDigests: Record<string, string> = {};
      const recordedPrevDigest = previousBuildId
        ? state?.routingImageDigests?.[previousBuildId]
        : undefined;
      if (previousBuildId && recordedPrevDigest) {
        routingImageDigests[previousBuildId] = recordedPrevDigest;
      }
      if (imageDigests.routingService) {
        routingImageDigests[buildId] = imageDigests.routingService;
      }
      // N30: carry (and prune to the builds in play) the record of which builds have NO
      // retained routing manifest, so doctor can qualify "rollback ready" honestly.
      const unretainedManifestBuilds = [
        ...(state?.unretainedManifestBuilds ?? []).filter((b) => b === previousBuildId),
        ...(unretainedManifestBuild ? [unretainedManifestBuild] : []),
      ].filter((b, i, all) => all.indexOf(b) === i);
      await writeState(
        projectDir,
        {
          buildId,
          previousBuildId,
          cdnTags,
          ...(Object.keys(routingImageDigests).length > 0 ? { routingImageDigests } : {}),
          // The build this deploy just installed serves /readyz, so the NEXT deploy can flip
          // the load balancer's HealthCheckPolicy to readiness without stranding it.
          readinessPathSupported: true,
          ...(unretainedManifestBuilds.length > 0 ? { unretainedManifestBuilds } : {}),
          // N21/N69: the generation this write is based on — writeState treats it as a floor
          // so the stamped value stays above the cluster's even if the pre-write cluster read
          // fails (in CI there is no local state.json to carry it forward). Required by the
          // StateWrite type: rollback used to omit the same value silently.
          basedOnGeneration: state?.generation ?? null,
        },
        releaseName,
      );
    } catch (err) {
      // N67: the warm-up widening is scoped to the warm-up on this path too — traffic HAS
      // switched, so the chart's own bounds are the right ones to autoscale under, and a
      // deploy that exits here must not leave a widened autoscaler for the operator to find.
      await restoreWidenedHpas();
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

    // 7d-bis. N67: the cutover is durable and the new build is taking 100% of traffic at
    // the outgoing build's capacity — the warm-up is over, so hand the pool back to the
    // chart's autoscaling bounds. Deliberately AFTER the state commit (a failure here must
    // never be able to lose a confirmed cutover) and BEFORE the best-effort steps below, so
    // the HPA is chart-intended on every path out of this function. Scaling DOWN from here
    // is the autoscaler's decision under real load, bounded by the operator's config.
    await restoreWidenedHpas();

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

    // N87. Prune internal dispatch Secrets that no Deployment references any more. Each
    // build renders its OWN Secret (`<release>-ihs-<build>-<digest>`) annotated
    // `helm.sh/resource-policy: keep`, so helm never prunes them — deliberately: the
    // retained previous build's pods reference theirs BY NAME and a missing secretKeyRef is
    // CreateContainerConfigError, so pruning on upgrade would brick both a restart in the
    // deploy window and the rollback. Keeping them makes GC this step's job (the
    // routing-manifest snapshots accumulated unboundedly for exactly the same reason).
    //
    // Classify by what is actually REFERENCED, not by build id: that covers the current
    // build, the retained previous build, the LEGACY stable-named Secret still needed by a
    // pre-N87 rollback target, the builds whose Deployments were just deleted above, and
    // leftovers from an earlier incarnation of this release name — with no assumption about
    // which builds exist. Conservative on every failure: an unreadable or unparseable
    // reference set skips the sweep entirely, because deleting a Secret a live pod template
    // needs would brick that build's restarts. Best-effort — state is already committed
    // (7d), so a failure here only leaks a handful of 64-byte Secrets.
    const deploySpecs = await execCapture("kubectl", [
      "get",
      "deployments",
      "-n",
      K8S_NAMESPACE,
      "-l",
      `app.kubernetes.io/name=${releaseName}`,
      "-o",
      "json",
    ]);
    let referencedSecrets: Set<string> | null = null;
    if (deploySpecs.exitCode === 0 && deploySpecs.stdout.trim()) {
      try {
        const parsed = JSON.parse(deploySpecs.stdout) as {
          items?: {
            spec?: {
              template?: {
                spec?: {
                  containers?: { env?: { valueFrom?: { secretKeyRef?: { name?: string } } }[] }[];
                };
              };
            };
          }[];
        };
        // Every secretKeyRef, not only the internal one — a superset is harmless here
        // because only Secrets carrying the internal-secret component label are candidates.
        referencedSecrets = new Set(
          (parsed.items ?? []).flatMap((d) =>
            (d.spec?.template?.spec?.containers ?? []).flatMap((c) =>
              (c.env ?? [])
                .map((e) => e.valueFrom?.secretKeyRef?.name)
                .filter((n): n is string => typeof n === "string" && n.length > 0),
            ),
          ),
        );
        // Belt and braces: this deploy's own Secret is referenced by definition, and the
        // pod templates it belongs to may not be listed yet on a slow API read.
        referencedSecrets.add(internalSecretName(releaseName, buildId));
        if (previousBuildId) {
          referencedSecrets.add(internalSecretName(releaseName, previousBuildId));
        }
      } catch {
        referencedSecrets = null;
      }
    }
    if (referencedSecrets === null) {
      console.warn(
        `  ! Could not read which Secrets the release's Deployments reference ` +
          `(kubectl exit ${deploySpecs.exitCode}) — skipping the internal-secret prune. ` +
          `Old per-build dispatch Secrets stay until the next successful deploy.`,
      );
    } else {
      const internalSecrets = await execCapture("kubectl", [
        "get",
        "secrets",
        "-n",
        K8S_NAMESPACE,
        "-l",
        `app.kubernetes.io/name=${releaseName},` +
          `app.kubernetes.io/component=${INTERNAL_SECRET_COMPONENT}`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
      ]);
      if (internalSecrets.exitCode === 0) {
        for (const secretName of internalSecrets.stdout.trim().split("\n")) {
          if (!secretName || referencedSecrets.has(secretName)) continue;
          console.log(`  → Deleting unreferenced internal dispatch Secret: ${secretName}`);
          await execCapture("kubectl", ["delete", "secret", secretName, "-n", K8S_NAMESPACE]);
        }
      }
    }
  }

  // 8. Run domain health checks BEFORE the completion banner (N33). "✓ Deploy complete"
  // used to print first, so a FAIL row underneath it read as cosmetic and the exit code
  // stayed 0 — a release unreachable at its own hostname reported success.
  let domainFailures = 0;
  if (!dryRun) {
    const { runDomainChecks } = await import("./doctor.js");
    // runDomainChecks prints its own rows; the return value (when it reports one) counts
    // the FAIL rows so the exit code can reflect them.
    const domainResult = (await runDomainChecks({ projectDir, releaseName })) as unknown as
      | { failures?: number }
      | undefined;
    if (domainResult && typeof domainResult.failures === "number") {
      domainFailures = domainResult.failures;
    }
  }

  if (domainFailures > 0) {
    console.error(
      `\n  ! Deploy finished (build: ${buildId}) but ${domainFailures} domain check(s) ` +
        `FAILED — the release may not be reachable at its configured host(s). ` +
        `Diagnose: npx adapter-k8s doctor`,
    );
    console.error("");
    process.exit(1);
  }

  console.log(`\n✓ Deploy complete (build: ${buildId})`);

  console.log("");
}
