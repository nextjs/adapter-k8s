import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  assertKubernetesServerVersion,
  parseAndVerifyCompositionPlan,
  type CompositionPlan,
  type CompositionPlanDigest,
  type DiagnosticSource,
  type KubernetesApiRequirement,
  type KubernetesObjectRef,
  type RoutingReadiness,
} from "../composition-plan/index.js";
import { compositionPlanConfigMapName } from "../emit/templates/composition-plan-configmap.js";
import { outputDirName } from "./infrastructure-validation.js";
import { sanitizeForTerminal } from "./terminal.js";
import { EXEC_TIMEOUTS, execCapture, execOrThrow } from "./exec.js";

const PLAN_FILE = "composition-plan.json";
const PLAN_DIGEST_ANNOTATION = "adapter-k8s.dev/composition-digest";
const DEFAULT_GCP_READINESS_TIMEOUT_SECONDS = 600;

export interface CompositionPlanMetadata {
  compositionPlan?:
    | {
        digest?: unknown;
        targetFingerprint?: unknown;
      }
    | undefined;
  buildId?: unknown;
}

export interface LoadedCompositionPlan {
  plan: CompositionPlan;
  digest: CompositionPlanDigest;
  source: string;
}

export interface CompositionPlanCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
  fix?: string;
}

export interface CompositionPlanDescription {
  resources: Array<{
    ref: KubernetesObjectRef;
    lifecycle: "helm" | "retain-with-build" | "retain-with-pool" | "apply";
  }>;
  logs: Array<{
    namespace: string;
    selector: string;
    containers: "all";
  }>;
  cleanup: {
    kubernetes: CompositionPlan["operations"]["cleanup"]["kubernetes"]["contributedObjects"];
    external: CompositionPlan["operations"]["cleanup"]["external"];
    retained: CompositionPlan["operations"]["cleanup"]["retained"];
  };
}

interface KubernetesObject {
  metadata?: { generation?: number };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

interface ReadinessEvaluation {
  ready: boolean;
  final: boolean;
  message: string;
}

function readJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Failed to parse ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function digest(value: unknown, source: string): CompositionPlanDigest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${source} must be sha256:<64 lowercase hex characters>`);
  }
  return value as CompositionPlanDigest;
}

function sameLocation(
  a: { kind: string; name: string },
  b: { kind: string; name: string },
): boolean {
  return a.kind === b.kind && a.name === b.name;
}

/**
 * Load the build's immutable operational plan. Legacy artifacts have neither the plan file nor
 * its metadata pointer and return null; a half-present pair is corruption and fails closed.
 */
export function loadLocalCompositionPlan(
  outputDir: string,
  metadata: CompositionPlanMetadata,
): LoadedCompositionPlan | null {
  const filePath = path.join(outputDir, PLAN_FILE);
  const pointer = metadata.compositionPlan;
  if (!pointer && !existsSync(filePath)) return null;
  if (!pointer) {
    throw new Error(
      `${filePath} exists but build-metadata.json has no compositionPlan digest. Refusing to ` +
        `execute an unauthenticated leftover plan; rebuild the adapter output.`,
    );
  }
  if (!existsSync(filePath)) {
    throw new Error(
      `build-metadata.json references a composition plan, but ${filePath} is missing. Rebuild ` +
        `the adapter output.`,
    );
  }
  const expectedDigest = digest(pointer.digest, "build-metadata.json compositionPlan.digest");
  const plan = parseAndVerifyCompositionPlan(
    readJson(readFileSync(filePath, "utf8"), filePath),
    expectedDigest,
  );
  const expectedFingerprint = digest(
    pointer.targetFingerprint,
    "build-metadata.json compositionPlan.targetFingerprint",
  );
  if (plan.target.fingerprint !== expectedFingerprint) {
    throw new Error(
      `Composition-plan target fingerprint mismatch: build metadata records ` +
        `${expectedFingerprint}, but the verified plan records ${plan.target.fingerprint}.`,
    );
  }
  if (typeof metadata.buildId === "string" && plan.metadata.buildId !== metadata.buildId) {
    throw new Error(
      `Composition-plan build mismatch: build metadata records ${metadata.buildId}, but the ` +
        `verified plan records ${plan.metadata.buildId}.`,
    );
  }
  return { plan, digest: expectedDigest, source: filePath };
}

/** Load a command's local build artifact when one is available. */
export function loadProjectCompositionPlan(projectDir: string): LoadedCompositionPlan | null {
  const outputDir = path.join(projectDir, ".k8s-adapter", outputDirName());
  const metadataPath = path.join(outputDir, "build-metadata.json");
  if (!existsSync(metadataPath)) return null;
  const metadata = readJson(
    readFileSync(metadataPath, "utf8"),
    metadataPath,
  ) as CompositionPlanMetadata;
  return loadLocalCompositionPlan(outputDir, metadata);
}

/** Load the exact retained ConfigMap for a deployed build and verify its own digest annotation. */
export async function loadDeployedCompositionPlan(options: {
  releaseName: string;
  namespace: string;
  buildId: string;
  expected?: {
    digest: CompositionPlanDigest;
    targetFingerprint: CompositionPlanDigest;
  };
}): Promise<LoadedCompositionPlan | null> {
  const name = compositionPlanConfigMapName(options.releaseName, options.buildId);
  const result = await execCapture(
    "kubectl",
    ["get", "configmap", name, "-n", options.namespace, "-o", "json", "--ignore-not-found"],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not read deployed composition plan ConfigMap ${options.namespace}/${name}: ` +
        sanitizeForTerminal(result.stderr.trim() || `kubectl exited ${result.exitCode}`),
    );
  }
  if (!result.stdout.trim()) {
    // `--ignore-not-found` is the machine-readable absence signal: missing returns exit 0 with
    // an empty body, while authentication, connectivity and authorization failures stay nonzero.
    return null;
  }
  const object = readJson(result.stdout, `ConfigMap ${options.namespace}/${name}`) as {
    metadata?: { annotations?: Record<string, unknown> };
    data?: Record<string, unknown>;
  };
  const expectedDigest = digest(
    object.metadata?.annotations?.[PLAN_DIGEST_ANNOTATION],
    `ConfigMap ${options.namespace}/${name} annotation ${PLAN_DIGEST_ANNOTATION}`,
  );
  if (options.expected && expectedDigest !== options.expected.digest) {
    throw new Error(
      `Deployed composition-plan digest does not match committed deploy state: ConfigMap ` +
        `${options.namespace}/${name} records ${expectedDigest}, state records ` +
        `${options.expected.digest}.`,
    );
  }
  const planJson = object.data?.["plan.json"];
  if (typeof planJson !== "string") {
    throw new Error(`ConfigMap ${options.namespace}/${name} has no string data["plan.json"]`);
  }
  const plan = parseAndVerifyCompositionPlan(
    readJson(planJson, `ConfigMap ${options.namespace}/${name} data["plan.json"]`),
    expectedDigest,
  );
  if (options.expected && plan.target.fingerprint !== options.expected.targetFingerprint) {
    throw new Error(
      `Deployed composition-plan target fingerprint does not match committed deploy state: ` +
        `plan records ${plan.target.fingerprint}, state records ` +
        `${options.expected.targetFingerprint}.`,
    );
  }
  if (
    plan.metadata.releaseName !== options.releaseName ||
    plan.metadata.namespace !== options.namespace ||
    plan.metadata.buildId !== options.buildId
  ) {
    throw new Error(
      `Deployed composition-plan identity mismatch: requested ` +
        `${options.namespace}/${options.releaseName}@${options.buildId}, found ` +
        `${plan.metadata.namespace}/${plan.metadata.releaseName}@${plan.metadata.buildId}.`,
    );
  }
  return { plan, digest: expectedDigest, source: `ConfigMap ${options.namespace}/${name}` };
}

export function assertCompositionPlanInvocation(
  plan: CompositionPlan,
  expected: { releaseName: string; namespace: string; buildId: string },
): void {
  for (const [field, actual, wanted] of [
    ["release", plan.metadata.releaseName, expected.releaseName],
    ["namespace", plan.metadata.namespace, expected.namespace],
    ["build", plan.metadata.buildId, expected.buildId],
  ] as const) {
    if (actual !== wanted) {
      throw new Error(
        `Composition-plan ${field} mismatch: plan records ${JSON.stringify(actual)}, ` +
          `but this deploy targets ${JSON.stringify(wanted)}. Rebuild for the selected target.`,
      );
    }
  }
}

export function compositionPlanNeedsExplicitConfirmation(plan: CompositionPlan): boolean {
  return (
    plan.target.identity.kind === "unverified" ||
    plan.target.access.kind === "kubeconfig-current-context"
  );
}

async function readCurrentKubeContext(): Promise<string | null> {
  const result = await execCapture("kubectl", ["config", "current-context"], {
    timeoutMs: EXEC_TIMEOUTS.kubectl,
  }).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

export async function currentKubeContext(): Promise<string | null> {
  const current = await readCurrentKubeContext();
  return current ? sanitizeForTerminal(current) : null;
}

async function establishClusterAccess(plan: CompositionPlan): Promise<void> {
  const access = plan.target.access;
  switch (access.kind) {
    case "gke-get-credentials": {
      const locationFlag = access.location.kind === "zone" ? "--zone" : "--region";
      await execOrThrow(
        "gcloud",
        [
          "container",
          "clusters",
          "get-credentials",
          access.clusterName,
          locationFlag,
          access.location.name,
          "--project",
          access.projectId,
          "--quiet",
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      return;
    }
    case "kubeconfig-context": {
      const current = await readCurrentKubeContext();
      if (current !== access.context) {
        throw new Error(
          `Composition plan requires kubeconfig context ${JSON.stringify(access.context)}, but ` +
            `the current context is ${JSON.stringify(current ? sanitizeForTerminal(current) : "unavailable")}. Select the ` +
            `required context before deploying.`,
        );
      }
      return;
    }
    case "kubeconfig-current-context":
      return;
  }
}

async function rawKubernetes(pathname: string): Promise<unknown> {
  const result = await execCapture("kubectl", ["get", "--raw", pathname], {
    timeoutMs: EXEC_TIMEOUTS.kubectl,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Kubernetes API read ${pathname} failed: ` +
        sanitizeForTerminal(result.stderr.trim() || `kubectl exited ${result.exitCode}`),
    );
  }
  return readJson(result.stdout, `Kubernetes API response ${pathname}`);
}

function apiRoot(apiVersion: string): string {
  if (apiVersion === "v1") return "/api/v1";
  const slash = apiVersion.lastIndexOf("/");
  return `/apis/${apiVersion.slice(0, slash)}/${apiVersion.slice(slash + 1)}`;
}

function objectPath(ref: KubernetesObjectRef): string {
  const root = apiRoot(ref.apiVersion);
  const namespace = ref.namespace ? `/namespaces/${encodeURIComponent(ref.namespace)}` : "";
  return `${root}${namespace}/${ref.resource}/${encodeURIComponent(ref.name)}`;
}

async function verifyClusterIdentity(
  plan: CompositionPlan,
  explicitlyConfirmed: boolean,
): Promise<string> {
  const identity = plan.target.identity;
  switch (identity.kind) {
    case "unverified":
      if (!explicitlyConfirmed) {
        throw new Error(
          "The composition plan cannot verify the cluster identity. Re-run with --yes only " +
            "after confirming the printed kubectl context is the intended cluster.",
        );
      }
      return `explicitly confirmed current context (${(await currentKubeContext()) ?? "unknown"})`;
    case "kubernetes-namespace-uid": {
      const namespace = (await rawKubernetes(
        `/api/v1/namespaces/${encodeURIComponent(identity.namespace)}`,
      )) as { metadata?: { uid?: unknown } };
      if (namespace.metadata?.uid !== identity.uid) {
        throw new Error(
          `Cluster identity mismatch: ${identity.namespace} UID is ` +
            `${JSON.stringify(namespace.metadata?.uid ?? "missing")}, expected ` +
            `${JSON.stringify(identity.uid)}.`,
        );
      }
      return `${identity.namespace} uid ${identity.uid}`;
    }
    case "gke-resource": {
      const access = plan.target.access;
      const accessBindsIdentity =
        access.kind === "gke-get-credentials" &&
        access.projectId === identity.projectId &&
        access.clusterName === identity.clusterName &&
        sameLocation(access.location, identity.location);
      if (!accessBindsIdentity && !identity.expectedKubeSystemUid) {
        throw new Error(
          `The GKE composition-plan identity ${identity.projectId}/${identity.clusterName} is ` +
            `not bound to its cluster access operation and has no expected kube-system UID. ` +
            `Refusing to infer that the current kubectl context names the same cluster.`,
        );
      }
      if (identity.expectedKubeSystemUid) {
        const namespace = (await rawKubernetes("/api/v1/namespaces/kube-system")) as {
          metadata?: { uid?: unknown };
        };
        if (namespace.metadata?.uid !== identity.expectedKubeSystemUid) {
          throw new Error(
            `Cluster identity mismatch: kube-system UID is ` +
              `${JSON.stringify(namespace.metadata?.uid ?? "missing")}, expected ` +
              `${JSON.stringify(identity.expectedKubeSystemUid)}.`,
          );
        }
      }
      return `${identity.projectId}/${identity.clusterName} (${identity.location.kind} ${identity.location.name})`;
    }
  }
}

function implicitRequirements(plan: CompositionPlan): KubernetesApiRequirement[] {
  const readiness = compositionPlanReadiness(plan);
  return [
    ...plan.operations.resources.objects.map((object) => ({
      apiVersion: object.apiVersion,
      resource: object.resource,
      optional: false as const,
    })),
    ...readiness.flatMap((entry): KubernetesApiRequirement[] => {
      if (entry.kind === "gcp-traffic-extension") return [];
      if (entry.kind === "kubernetes-service-endpoints") {
        return [
          { apiVersion: "v1", resource: "services", optional: false },
          { apiVersion: "discovery.k8s.io/v1", resource: "endpointslices", optional: false },
        ];
      }
      return [
        { apiVersion: entry.object.apiVersion, resource: entry.object.resource, optional: false },
      ];
    }),
  ];
}

export async function inspectKubernetesRequirements(
  plan: CompositionPlan,
): Promise<{ serverVersion: string; missingOptional: KubernetesApiRequirement[] }> {
  const version = (await rawKubernetes("/version")) as { gitVersion?: unknown };
  if (typeof version.gitVersion !== "string") {
    throw new Error("Kubernetes /version response has no string gitVersion");
  }
  assertKubernetesServerVersion(version.gitVersion, plan.requirements.kubernetes.minimumVersion);

  const requirements = new Map<string, KubernetesApiRequirement>();
  for (const requirement of [
    ...plan.requirements.kubernetes.resources,
    ...implicitRequirements(plan),
  ]) {
    const key = `${requirement.apiVersion}/${requirement.resource}`;
    const prior = requirements.get(key);
    requirements.set(key, {
      ...requirement,
      optional: prior ? prior.optional && requirement.optional : requirement.optional,
    });
  }
  const byVersion = new Map<string, KubernetesApiRequirement[]>();
  for (const requirement of requirements.values()) {
    const entries = byVersion.get(requirement.apiVersion) ?? [];
    entries.push(requirement);
    byVersion.set(requirement.apiVersion, entries);
  }
  const missingRequired: KubernetesApiRequirement[] = [];
  const missingOptional: KubernetesApiRequirement[] = [];
  const kindMismatches: string[] = [];
  const expectedKinds = new Map<string, Set<string>>();
  for (const object of plan.operations.resources.objects) {
    const key = `${object.apiVersion}/${object.resource}`;
    const kinds = expectedKinds.get(key) ?? new Set<string>();
    kinds.add(object.kind);
    expectedKinds.set(key, kinds);
  }
  for (const [apiVersion, entries] of byVersion) {
    let discovered = new Map<string, string>();
    try {
      const discovery = (await rawKubernetes(apiRoot(apiVersion))) as {
        resources?: Array<{ name?: unknown; kind?: unknown }>;
      };
      discovered = new Map(
        (discovery.resources ?? []).flatMap((entry) =>
          typeof entry.name === "string" && typeof entry.kind === "string"
            ? [[entry.name, entry.kind] as const]
            : [],
        ),
      );
    } catch (error) {
      const allOptional = entries.every((entry) => entry.optional);
      if (!allOptional) throw error;
    }
    for (const requirement of entries) {
      const actualKind = discovered.get(requirement.resource);
      if (!actualKind) {
        (requirement.optional ? missingOptional : missingRequired).push(requirement);
        continue;
      }
      const expected = expectedKinds.get(`${apiVersion}/${requirement.resource}`);
      if (expected && !expected.has(actualKind)) {
        kindMismatches.push(
          `${apiVersion}/${requirement.resource} reports kind ${actualKind}, expected ${[...expected].join(" or ")}`,
        );
      }
    }
  }
  if (missingRequired.length > 0) {
    throw new Error(
      `Kubernetes cluster is missing required APIs: ${missingRequired
        .map((entry) => `${entry.apiVersion}/${entry.resource}`)
        .join(", ")}. Install the corresponding CRDs/controllers before deploying.`,
    );
  }
  if (kindMismatches.length > 0) {
    throw new Error(
      `Kubernetes API discovery does not match the composition plan: ${kindMismatches.join(
        "; ",
      )}. Fix the component's resource/kind pair before deploying.`,
    );
  }
  return { serverVersion: version.gitVersion, missingOptional };
}

export async function preflightCompositionPlan(
  plan: CompositionPlan,
  options: { explicitlyConfirmed: boolean },
): Promise<{
  clusterIdentity: string;
  serverVersion: string;
  missingOptional: KubernetesApiRequirement[];
}> {
  if (compositionPlanNeedsExplicitConfirmation(plan) && !options.explicitlyConfirmed) {
    throw new Error(
      "This composition plan requires explicit confirmation of the current kubectl context. " +
        "Re-run with --yes only after verifying that context.",
    );
  }
  await establishClusterAccess(plan);
  const clusterIdentity = await verifyClusterIdentity(plan, options.explicitlyConfirmed);
  const requirements = await inspectKubernetesRequirements(plan);
  return { clusterIdentity, ...requirements };
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function conditionStatus(
  object: KubernetesObject,
  readiness: Extract<RoutingReadiness, { kind: "kubernetes-condition" }>,
): ReadinessEvaluation {
  const generation = object.metadata?.generation;
  const status = object.status ?? {};
  let owners: Array<Record<string, unknown>>;
  switch (readiness.conditionsAt.kind) {
    case "object":
      owners = [status];
      break;
    case "parents": {
      const parents = records(status.parents);
      const controllerName = readiness.conditionsAt.controllerName;
      owners = controllerName
        ? parents.filter((entry) => entry.controllerName === controllerName)
        : parents;
      break;
    }
    case "ancestors": {
      const controllerName = readiness.conditionsAt.controllerName;
      owners = records(status.ancestors).filter((entry) => entry.controllerName === controllerName);
      break;
    }
  }
  if (owners.length === 0) {
    return { ready: false, final: false, message: "condition owner has not been reported" };
  }
  const conditions = owners.map((owner) =>
    records(owner.conditions).find((entry) => entry.type === readiness.condition.type),
  );
  if (conditions.some((condition) => condition === undefined)) {
    return {
      ready: false,
      final: false,
      message: `${readiness.condition.type} has not been reported for every matching status entry`,
    };
  }
  for (const condition of conditions as Array<Record<string, unknown>>) {
    if (condition.status === "False") {
      return {
        ready: false,
        final: false,
        message: sanitizeForTerminal(
          String(condition.message ?? condition.reason ?? `${readiness.condition.type}=False`),
        ),
      };
    }
    if (condition.status !== readiness.condition.status) {
      return {
        ready: false,
        final: false,
        message: `${readiness.condition.type}=${String(condition.status ?? "Unknown")}`,
      };
    }
    if (generation === undefined || condition.observedGeneration !== generation) {
      return {
        ready: false,
        final: false,
        message: `${readiness.condition.type} is stale for generation ${String(generation ?? "unknown")}`,
      };
    }
  }
  return {
    ready: true,
    final: true,
    message: `${readiness.condition.type}=True for generation ${generation}`,
  };
}

async function evaluateKubernetesReadiness(
  readiness: Exclude<RoutingReadiness, { kind: "gcp-traffic-extension" }>,
): Promise<ReadinessEvaluation> {
  if (readiness.kind === "kubernetes-service-endpoints") {
    const root = apiRoot("discovery.k8s.io/v1");
    const selector = encodeURIComponent(`kubernetes.io/service-name=${readiness.service.name}`);
    const response = (await rawKubernetes(
      `${root}/namespaces/${encodeURIComponent(readiness.service.namespace)}/endpointslices?labelSelector=${selector}`,
    )) as {
      items?: Array<{
        endpoints?: Array<{ conditions?: { ready?: unknown; terminating?: unknown } }>;
      }>;
    };
    const ready = (response.items ?? [])
      .flatMap((item) => item.endpoints ?? [])
      // EndpointSlice defines nil `ready` as true. A terminating endpoint can still be
      // serving during drain, but it is not durable capacity for a cutover readiness gate.
      .filter(
        (endpoint) =>
          endpoint.conditions?.ready !== false && endpoint.conditions?.terminating !== true,
      ).length;
    return {
      ready: ready >= readiness.minimumReady,
      final: false,
      message: `${ready}/${readiness.minimumReady} ready service endpoints`,
    };
  }

  const object = (await rawKubernetes(objectPath(readiness.object))) as KubernetesObject;
  if (readiness.kind === "kubernetes-condition") {
    return conditionStatus(object, readiness);
  }
  if (readiness.kind === "kubernetes-job-complete") {
    const complete = records(object.status?.conditions).find((entry) => entry.type === "Complete");
    const failed = records(object.status?.conditions).find(
      (entry) => entry.type === "Failed" && entry.status === "True",
    );
    if (failed) {
      return {
        ready: false,
        final: true,
        message: sanitizeForTerminal(String(failed.message ?? failed.reason ?? "Job failed")),
      };
    }
    return {
      ready: complete?.status === "True",
      final: false,
      message: complete?.status === "True" ? "Job Complete=True" : "Job is not complete",
    };
  }

  const generation = object.metadata?.generation;
  const observed = object.status?.observedGeneration;
  const desired = typeof object.spec?.replicas === "number" ? Math.max(1, object.spec.replicas) : 1;
  const available =
    typeof object.status?.availableReplicas === "number" ? object.status.availableReplicas : 0;
  const current =
    typeof observed === "number" && generation !== undefined && observed >= generation;
  return {
    ready: current && available >= desired,
    final: false,
    message: `${available}/${desired} available replicas${current ? "" : "; controller status is stale"}`,
  };
}

async function evaluateGcpTrafficExtension(
  readiness: Extract<RoutingReadiness, { kind: "gcp-traffic-extension" }>,
): Promise<ReadinessEvaluation> {
  const extension = await execCapture(
    "gcloud",
    [
      "service-extensions",
      "lb-traffic-extensions",
      "describe",
      readiness.extensionName,
      "--location=global",
      "--project",
      readiness.projectId,
      "--format=json",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (extension.exitCode !== 0) {
    return {
      ready: false,
      final: false,
      message: sanitizeForTerminal(extension.stderr.trim() || "traffic extension not found"),
    };
  }
  const extensionObject = readJson(extension.stdout, "gcloud traffic-extension response") as {
    forwardingRules?: unknown;
  };
  const covered = new Set(
    (Array.isArray(extensionObject.forwardingRules) ? extensionObject.forwardingRules : [])
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.split("/").pop()!),
  );
  const address = await execCapture(
    "gcloud",
    [
      "compute",
      "addresses",
      "describe",
      readiness.addressName,
      "--global",
      "--project",
      readiness.projectId,
      "--format=value(address)",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  const ip = address.exitCode === 0 ? address.stdout.trim() : "";
  if (!ip) return { ready: false, final: false, message: "release address is not ready" };
  const rules = await execCapture(
    "gcloud",
    [
      "compute",
      "forwarding-rules",
      "list",
      "--project",
      readiness.projectId,
      "--filter",
      `IPAddress=${ip}`,
      "--format=value(name)",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (rules.exitCode !== 0) {
    return {
      ready: false,
      final: false,
      message: sanitizeForTerminal(rules.stderr.trim() || "forwarding rules are unavailable"),
    };
  }
  const expected = rules.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (expected.length === 0) {
    return { ready: false, final: false, message: "release has no forwarding rules yet" };
  }
  const missing = expected.filter((name) => !covered.has(name));
  return {
    ready: missing.length === 0,
    final: false,
    message:
      missing.length === 0
        ? `traffic extension covers all ${expected.length} forwarding rules`
        : `traffic extension is missing forwarding rules: ${missing.join(", ")}`,
  };
}

function readinessKey(readiness: RoutingReadiness): string {
  return JSON.stringify(readiness);
}

export function compositionPlanReadiness(plan: CompositionPlan): RoutingReadiness[] {
  const routingReadiness = plan.operations.routing.dataplane.readiness;
  const unique = new Map<string, RoutingReadiness>();
  for (const readiness of [...plan.operations.resources.readiness, ...routingReadiness]) {
    unique.set(readinessKey(readiness), readiness);
  }
  return [...unique.values()];
}

export async function evaluateCompositionPlanReadiness(
  plan: CompositionPlan,
): Promise<CompositionPlanCheck[]> {
  const results: CompositionPlanCheck[] = [];
  for (const readiness of compositionPlanReadiness(plan)) {
    let result: ReadinessEvaluation;
    try {
      result =
        readiness.kind === "gcp-traffic-extension"
          ? await evaluateGcpTrafficExtension(readiness)
          : await evaluateKubernetesReadiness(readiness);
    } catch (error) {
      result = {
        ready: false,
        final: false,
        message: sanitizeForTerminal(error instanceof Error ? error.message : String(error)),
      };
    }
    results.push({
      name: readinessLabel(readiness),
      status: result.ready ? "pass" : "fail",
      message: result.message,
      ...(!result.ready && readiness.kind !== "gcp-traffic-extension"
        ? { fix: readinessFix(readiness) }
        : {}),
    });
  }
  return results;
}

export async function evaluateCompositionPlanDiagnostics(
  plan: CompositionPlan,
): Promise<CompositionPlanCheck[]> {
  const checks: CompositionPlanCheck[] = [];
  for (const diagnostic of plan.operations.diagnostics) {
    let status: CompositionPlanCheck["status"] = "fail";
    let message = "not available";
    try {
      switch (diagnostic.kind) {
        case "kubernetes-condition": {
          const result = await evaluateKubernetesReadiness(diagnostic.check);
          status = result.ready ? "pass" : "fail";
          message = result.message;
          break;
        }
        case "kubernetes-gateway-address": {
          const object = (await rawKubernetes(objectPath(diagnostic.gateway))) as {
            status?: { addresses?: Array<{ value?: unknown }> };
          };
          const addresses = (object.status?.addresses ?? [])
            .map((entry) => entry.value)
            .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
          status = addresses.length > 0 ? "pass" : "warn";
          message = addresses.length > 0 ? addresses.join(", ") : "address is pending";
          break;
        }
        case "gcp-auth": {
          const result = await execCapture(
            "gcloud",
            ["auth", "print-access-token", `--project=${diagnostic.projectId}`, "--quiet"],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          status = result.exitCode === 0 ? "pass" : "fail";
          message = result.exitCode === 0 ? "authenticated" : result.stderr.trim();
          break;
        }
        case "gcp-global-address": {
          const result = await execCapture(
            "gcloud",
            [
              "compute",
              "addresses",
              "describe",
              diagnostic.name,
              "--global",
              `--project=${diagnostic.projectId}`,
              "--format=value(address)",
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          const address = result.exitCode === 0 ? result.stdout.trim() : "";
          status = address ? "pass" : "fail";
          message = address || result.stderr.trim() || "address not found";
          break;
        }
        case "gcp-storage-bucket": {
          const result = await execCapture(
            "gcloud",
            [
              "storage",
              "buckets",
              "describe",
              `gs://${diagnostic.bucket}`,
              `--project=${diagnostic.projectId}`,
              "--format=value(name)",
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          status = result.exitCode === 0 ? "pass" : "fail";
          message = result.stdout.trim() || result.stderr.trim() || "bucket not found";
          break;
        }
        case "gcp-artifact-registry": {
          const result = await execCapture(
            "gcloud",
            [
              "artifacts",
              "repositories",
              "describe",
              diagnostic.repository,
              `--location=${diagnostic.region}`,
              `--project=${diagnostic.projectId}`,
              "--format=value(name)",
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          status = result.exitCode === 0 ? "pass" : "fail";
          message = result.stdout.trim() || result.stderr.trim() || "repository not found";
          break;
        }
        case "gcp-backend-health": {
          const result = await execCapture(
            "gcloud",
            [
              "compute",
              "backend-services",
              "get-health",
              `${diagnostic.releasePrefix}-routing-service`,
              "--global",
              `--project=${diagnostic.projectId}`,
              "--format=json",
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          status = result.exitCode === 0 ? "pass" : "fail";
          message = result.exitCode === 0 ? "backend health is readable" : result.stderr.trim();
          break;
        }
        case "gcp-traffic-extension": {
          const result = await evaluateGcpTrafficExtension({
            kind: "gcp-traffic-extension",
            projectId: diagnostic.projectId,
            extensionName: diagnostic.extensionName,
            addressName: diagnostic.addressName,
            requireEveryForwardingRule: true,
          });
          status = result.ready ? "pass" : "fail";
          message = result.message;
          break;
        }
        case "gcp-backend-service-shape": {
          const result = await execCapture(
            "gcloud",
            [
              "compute",
              "backend-services",
              "describe",
              diagnostic.name,
              "--global",
              `--project=${diagnostic.projectId}`,
              "--format=json",
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          if (result.exitCode !== 0) {
            message = result.stderr.trim() || "backend service not found";
            break;
          }
          const object = readJson(result.stdout, "gcloud backend-service response") as {
            loadBalancingScheme?: unknown;
            backends?: unknown;
          };
          const schemeMatches = object.loadBalancingScheme === diagnostic.loadBalancingScheme;
          const hasBackend =
            !diagnostic.requireBackend ||
            (Array.isArray(object.backends) && object.backends.length > 0);
          status = schemeMatches && hasBackend ? "pass" : "fail";
          message = schemeMatches
            ? hasBackend
              ? "backend service shape is valid"
              : "backend service has no backends"
            : `loadBalancingScheme=${String(object.loadBalancingScheme ?? "missing")}`;
          break;
        }
        case "gcp-health-check-shape": {
          const result = await execCapture(
            "gcloud",
            [
              "compute",
              "health-checks",
              "describe",
              diagnostic.name,
              "--global",
              `--project=${diagnostic.projectId}`,
              "--format=value(type)",
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          const actual = result.exitCode === 0 ? result.stdout.trim().toUpperCase() : "";
          status = actual === diagnostic.expectedType ? "pass" : "fail";
          message = actual || result.stderr.trim() || "health check not found";
          break;
        }
        case "gcp-certificate": {
          const result = await execCapture(
            "gcloud",
            [
              "certificate-manager",
              "certificates",
              "describe",
              diagnostic.name,
              `--project=${diagnostic.projectId}`,
              "--format=value(managed.state)",
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          const state = result.exitCode === 0 ? result.stdout.trim().toUpperCase() : "";
          status = state === "ACTIVE" ? "pass" : state === "PROVISIONING" ? "warn" : "fail";
          message = state || result.stderr.trim() || "certificate not found";
          break;
        }
      }
    } catch (error) {
      status = "fail";
      message = error instanceof Error ? error.message : String(error);
    }
    checks.push({
      name: diagnosticLabel(diagnostic),
      status,
      message: sanitizeForTerminal(message),
    });
  }
  return checks;
}

function diagnosticLabel(diagnostic: DiagnosticSource): string {
  switch (diagnostic.kind) {
    case "kubernetes-condition":
      return diagnostic.label;
    case "kubernetes-gateway-address":
      return `${refLabel(diagnostic.gateway)} address`;
    case "gcp-auth":
      return `GCP authentication ${diagnostic.projectId}`;
    case "gcp-global-address":
      return `GCP address ${diagnostic.name}`;
    case "gcp-storage-bucket":
      return `GCS bucket ${diagnostic.bucket}`;
    case "gcp-artifact-registry":
      return `Artifact Registry ${diagnostic.repository}`;
    case "gcp-backend-health":
      return `GCP backend health ${diagnostic.releasePrefix}`;
    case "gcp-traffic-extension":
      return `GCP traffic extension ${diagnostic.extensionName}`;
    case "gcp-backend-service-shape":
      return `GCP backend service ${diagnostic.name}`;
    case "gcp-health-check-shape":
      return `GCP health check ${diagnostic.name}`;
    case "gcp-certificate":
      return `GCP certificate ${diagnostic.name}`;
  }
}

function timeoutSeconds(readiness: RoutingReadiness): number {
  return readiness.kind === "kubernetes-service-endpoints"
    ? 120
    : readiness.kind === "gcp-traffic-extension"
      ? DEFAULT_GCP_READINESS_TIMEOUT_SECONDS
      : readiness.timeoutSeconds;
}

export async function waitForCompositionPlanReadiness(
  plan: CompositionPlan,
  options: { pollIntervalMs?: number } = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  for (const readiness of compositionPlanReadiness(plan)) {
    const deadline = Date.now() + timeoutSeconds(readiness) * 1_000;
    let last = "not reported";
    let ready = false;
    while (!ready && Date.now() <= deadline) {
      let result: ReadinessEvaluation | null = null;
      try {
        result =
          readiness.kind === "gcp-traffic-extension"
            ? await evaluateGcpTrafficExtension(readiness)
            : await evaluateKubernetesReadiness(readiness);
        last = result.message;
      } catch (error) {
        last = sanitizeForTerminal(error instanceof Error ? error.message : String(error));
      }
      if (result?.ready) {
        ready = true;
        break;
      }
      if (result?.final) throw new Error(`${readinessLabel(readiness)} failed: ${last}`);
      if (Date.now() > deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    if (!ready) {
      throw new Error(
        `${readinessLabel(readiness)} did not become ready within ` +
          `${timeoutSeconds(readiness)}s (${last}).`,
      );
    }
  }
}

function refLabel(ref: KubernetesObjectRef): string {
  return `${ref.apiVersion}/${ref.resource} ${ref.namespace ? `${ref.namespace}/` : ""}${ref.name}`;
}

function readinessLabel(readiness: RoutingReadiness): string {
  switch (readiness.kind) {
    case "kubernetes-condition":
      return `${refLabel(readiness.object)} ${readiness.condition.type}`;
    case "kubernetes-job-complete":
      return `${refLabel(readiness.object)} complete`;
    case "kubernetes-deployment-available":
      return `${refLabel(readiness.object)} available`;
    case "kubernetes-service-endpoints":
      return `v1/services ${readiness.service.namespace}/${readiness.service.name} endpoints`;
    case "gcp-traffic-extension":
      return `GCP traffic extension ${readiness.projectId}/${readiness.extensionName}`;
  }
}

function readinessFix(
  readiness: Exclude<RoutingReadiness, { kind: "gcp-traffic-extension" }>,
): string {
  if (readiness.kind === "kubernetes-service-endpoints") {
    return `kubectl get endpointslice -n ${readiness.service.namespace} -l kubernetes.io/service-name=${readiness.service.name}`;
  }
  const namespace = readiness.object.namespace ? ` -n ${readiness.object.namespace}` : "";
  return `kubectl describe ${readiness.object.resource} ${readiness.object.name}${namespace}`;
}

/** Exact, lossless operation inventory for describe/tail/destroy consumers. */
export function describeCompositionPlan(plan: CompositionPlan): CompositionPlanDescription {
  const lifecycle = new Map(
    plan.operations.cleanup.kubernetes.contributedObjects.map((owned) => [
      `${owned.ref.apiVersion}|${owned.ref.resource}|${owned.ref.namespace ?? ""}|${owned.ref.name}`,
      owned.lifecycle,
    ]),
  );
  return {
    resources: plan.operations.resources.objects.map((object) => ({
      ref: {
        apiVersion: object.apiVersion,
        resource: object.resource,
        name: object.metadata.name,
        ...(object.metadata.namespace ? { namespace: object.metadata.namespace } : {}),
      },
      lifecycle:
        lifecycle.get(
          `${object.apiVersion}|${object.resource}|${object.metadata.namespace ?? ""}|${object.metadata.name}`,
        ) ?? "apply",
    })),
    logs: plan.operations.logs.map((source) => ({
      namespace: source.namespace,
      selector: `adapter-k8s.dev/release=${source.selector.releaseName}`,
      containers: source.containers,
    })),
    cleanup: {
      kubernetes: plan.operations.cleanup.kubernetes.contributedObjects.map((entry) => ({
        ...entry,
        ref: { ...entry.ref },
        ownership: {
          releaseLabel: { ...entry.ownership.releaseLabel },
          ...(entry.ownership.helmRelease
            ? { helmRelease: { ...entry.ownership.helmRelease } }
            : {}),
        },
      })),
      external: plan.operations.cleanup.external.map((entry) => ({ ...entry })),
      retained: plan.operations.cleanup.retained.map((entry) => ({ ...entry })),
    },
  };
}
