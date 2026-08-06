import {
  assertSafeBucketName,
  assertSafeBuildId,
  assertSafeImageRegistry,
  assertSafeNamespace,
  assertSafeProjectId,
  assertSafeRegion,
  assertSafeReleaseName,
} from "../emit/templates/utils.js";
import {
  COMPOSITION_PLAN_API_VERSION,
  COMPOSITION_PLAN_KIND,
  MINIMUM_KUBERNETES_VERSION,
  type CacheProvisioning,
  type CdnInvalidation,
  type CleanupPlan,
  type ClusterAccess,
  type ClusterIdentity,
  type CompositionPlan,
  type DiagnosticSource,
  type ExternalCleanupOperation,
  type GcpLocation,
  type KubernetesApiRequirement,
  type KubernetesJsonValue,
  type KubernetesManifest,
  type KubernetesObjectRef,
  type KubernetesOwnedObject,
  type KubernetesServiceRef,
  type LogSource,
  type NetworkCidrSource,
  type NetworkPlan,
  type RegistryAuthentication,
  type RegistryDigestLookup,
  type RegistryPlan,
  type RetainedExternalResource,
  type RoutingPlan,
  type RoutingReadiness,
} from "./types.js";

type JsonObject = Record<string, unknown>;

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const API_VERSION_RE = /^(?:[a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?v[0-9][a-z0-9]*$/;
const RESOURCE_RE = /^[a-z][a-z0-9-]{0,62}$/;
const DNS_SUBDOMAIN_RE = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const CIDR_RE = /^(?:[0-9a-fA-F:.]+)\/[0-9]{1,3}$/;
const SERVICE_ACCOUNT_EMAIL_RE =
  /^[a-z][a-z0-9-]{0,62}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;

function fail(path: string, message: string): never {
  throw new Error(`Invalid composition plan at ${path}: ${message}`);
}

function object(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    fail(path, `unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "expected a non-empty string");
  return value;
}

function safeText(value: unknown, path: string, maxLength = 253): string {
  const parsed = string(value, path);
  const hasControlCharacter = [...parsed].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (parsed.length > maxLength || hasControlCharacter || parsed.startsWith("-")) {
    fail(path, `expected at most ${maxLength} printable characters and no leading "-"`);
  }
  return parsed;
}

function literal<const T extends string | boolean>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail(path, `expected ${JSON.stringify(expected)}`);
  return expected;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  expected: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !expected.includes(value)) {
    fail(path, `expected one of ${expected.map((item) => JSON.stringify(item)).join(", ")}`);
  }
  return value as T[number];
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(path, `expected an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function array<T>(
  value: unknown,
  path: string,
  parse: (entry: unknown, entryPath: string) => T,
  maximum = 256,
): T[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  if (value.length > maximum) fail(path, `expected at most ${maximum} entries`);
  return value.map((entry, index) => parse(entry, `${path}[${index}]`));
}

function validated(value: unknown, path: string, check: (candidate: string) => void): string {
  const parsed = string(value, path);
  try {
    check(parsed);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : String(error));
  }
  return parsed;
}

function optionalString(
  value: JsonObject,
  key: string,
  path: string,
  check?: (candidate: string) => void,
): string | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  return check
    ? validated(value[key], `${path}.${key}`, check)
    : safeText(value[key], `${path}.${key}`);
}

function parseGcpLocation(value: unknown, path: string): GcpLocation {
  const parsed = object(value, path);
  exactKeys(parsed, ["kind", "name"], path);
  const kind = oneOf(parsed.kind, ["region", "zone"] as const, `${path}.kind`);
  return {
    kind,
    name: validated(parsed.name, `${path}.name`, assertSafeRegion),
  };
}

function parseClusterIdentity(value: unknown, path: string): ClusterIdentity {
  const parsed = object(value, path);
  const kind = string(parsed.kind, `${path}.kind`);
  switch (kind) {
    case "gke-resource": {
      exactKeys(
        parsed,
        ["kind", "projectId", "clusterName", "location", "expectedKubeSystemUid"],
        path,
      );
      const expectedKubeSystemUid = optionalString(parsed, "expectedKubeSystemUid", path);
      return {
        kind,
        projectId: validated(parsed.projectId, `${path}.projectId`, assertSafeProjectId),
        clusterName: safeText(parsed.clusterName, `${path}.clusterName`, 63),
        location: parseGcpLocation(parsed.location, `${path}.location`),
        ...(expectedKubeSystemUid ? { expectedKubeSystemUid } : {}),
      };
    }
    case "kubernetes-namespace-uid":
      exactKeys(parsed, ["kind", "namespace", "uid"], path);
      return {
        kind,
        namespace: literal(parsed.namespace, "kube-system", `${path}.namespace`),
        uid: safeText(parsed.uid, `${path}.uid`, 128),
      };
    case "unverified":
      exactKeys(parsed, ["kind", "requireExplicitConfirmation"], path);
      return {
        kind,
        requireExplicitConfirmation: literal(
          parsed.requireExplicitConfirmation,
          true,
          `${path}.requireExplicitConfirmation`,
        ),
      };
    default:
      fail(`${path}.kind`, `unknown cluster identity operation ${JSON.stringify(kind)}`);
  }
}

function parseClusterAccess(value: unknown, path: string): ClusterAccess {
  const parsed = object(value, path);
  const kind = string(parsed.kind, `${path}.kind`);
  switch (kind) {
    case "kubeconfig-context":
      exactKeys(parsed, ["kind", "context"], path);
      return { kind, context: safeText(parsed.context, `${path}.context`) };
    case "kubeconfig-current-context":
      exactKeys(parsed, ["kind", "requireExplicitConfirmation"], path);
      return {
        kind,
        requireExplicitConfirmation: literal(
          parsed.requireExplicitConfirmation,
          true,
          `${path}.requireExplicitConfirmation`,
        ),
      };
    case "gke-get-credentials":
      exactKeys(parsed, ["kind", "projectId", "clusterName", "location"], path);
      return {
        kind,
        projectId: validated(parsed.projectId, `${path}.projectId`, assertSafeProjectId),
        clusterName: safeText(parsed.clusterName, `${path}.clusterName`, 63),
        location: parseGcpLocation(parsed.location, `${path}.location`),
      };
    default:
      fail(`${path}.kind`, `unknown cluster access operation ${JSON.stringify(kind)}`);
  }
}

function parseRegistryAuthentication(value: unknown, path: string): RegistryAuthentication {
  const parsed = object(value, path);
  const kind = string(parsed.kind, `${path}.kind`);
  switch (kind) {
    case "ambient-credentials":
      exactKeys(parsed, ["kind"], path);
      return { kind };
    case "gcloud-docker-helper":
      exactKeys(parsed, ["kind", "registryHost"], path);
      return { kind, registryHost: safeText(parsed.registryHost, `${path}.registryHost`) };
    default:
      fail(`${path}.kind`, `unknown registry authentication operation ${JSON.stringify(kind)}`);
  }
}

function parseRegistryDigestLookup(value: unknown, path: string): RegistryDigestLookup {
  const parsed = object(value, path);
  const kind = string(parsed.kind, `${path}.kind`);
  switch (kind) {
    case "oci-distribution":
      exactKeys(parsed, ["kind"], path);
      return { kind };
    case "gcp-artifact-registry":
      exactKeys(parsed, ["kind", "projectId"], path);
      return {
        kind,
        projectId: validated(parsed.projectId, `${path}.projectId`, assertSafeProjectId),
      };
    default:
      fail(`${path}.kind`, `unknown registry digest operation ${JSON.stringify(kind)}`);
  }
}

function parseRegistry(value: unknown, path: string): RegistryPlan {
  const parsed = object(value, path);
  exactKeys(parsed, ["repository", "authentication", "digestLookup"], path);
  return {
    repository: validated(parsed.repository, `${path}.repository`, assertSafeImageRegistry),
    authentication: parseRegistryAuthentication(parsed.authentication, `${path}.authentication`),
    digestLookup: parseRegistryDigestLookup(parsed.digestLookup, `${path}.digestLookup`),
  };
}

function parseNetworkSource(value: unknown, path: string): NetworkCidrSource {
  const parsed = object(value, path);
  const kind = string(parsed.kind, `${path}.kind`);
  switch (kind) {
    case "not-required":
    case "kubernetes-node-pod-cidrs":
      exactKeys(parsed, ["kind"], path);
      return { kind };
    case "static": {
      exactKeys(parsed, ["kind", "cidrs"], path);
      const cidrs = array(parsed.cidrs, `${path}.cidrs`, (entry, entryPath) => {
        const cidr = string(entry, entryPath);
        if (!CIDR_RE.test(cidr)) fail(entryPath, "expected an IPv4 or IPv6 CIDR");
        return cidr;
      });
      if (cidrs.length === 0) fail(`${path}.cidrs`, "expected at least one CIDR");
      if (new Set(cidrs).size !== cidrs.length) fail(`${path}.cidrs`, "duplicate CIDR");
      return { kind, cidrs };
    }
    case "kubernetes-node-addresses": {
      exactKeys(parsed, ["kind", "addressTypes"], path);
      if (!Array.isArray(parsed.addressTypes) || parsed.addressTypes.length !== 1) {
        fail(`${path}.addressTypes`, 'expected ["InternalIP"]');
      }
      const addressType = literal(parsed.addressTypes[0], "InternalIP", `${path}.addressTypes[0]`);
      return { kind, addressTypes: [addressType] };
    }
    case "gke-pod-range":
    case "gke-node-subnet":
      exactKeys(parsed, ["kind", "projectId", "clusterName", "location"], path);
      return {
        kind,
        projectId: validated(parsed.projectId, `${path}.projectId`, assertSafeProjectId),
        clusterName: safeText(parsed.clusterName, `${path}.clusterName`, 63),
        location: parseGcpLocation(parsed.location, `${path}.location`),
      };
    default:
      fail(`${path}.kind`, `unknown network source operation ${JSON.stringify(kind)}`);
  }
}

function parseNetwork(value: unknown, path: string): NetworkPlan {
  const parsed = object(value, path);
  exactKeys(parsed, ["podCidrs", "nodeCidrs", "missingSourcePolicy"], path);
  return {
    podCidrs: parseNetworkSource(parsed.podCidrs, `${path}.podCidrs`),
    nodeCidrs: parseNetworkSource(parsed.nodeCidrs, `${path}.nodeCidrs`),
    missingSourcePolicy: literal(parsed.missingSourcePolicy, "fail", `${path}.missingSourcePolicy`),
  };
}

function parseCache(value: unknown, path: string): CacheProvisioning {
  const parsed = object(value, path);
  const kind = string(parsed.kind, `${path}.kind`);
  switch (kind) {
    case "none":
      exactKeys(parsed, ["kind"], path);
      return { kind };
    case "external":
      exactKeys(parsed, ["kind", "lifecycle"], path);
      return {
        kind,
        lifecycle: literal(parsed.lifecycle, "operator-managed", `${path}.lifecycle`),
      };
    case "gcp-memorystore": {
      exactKeys(
        parsed,
        ["kind", "projectId", "region", "name", "network", "sizeGb", "tier", "security"],
        path,
      );
      const security = object(parsed.security, `${path}.security`);
      exactKeys(security, ["kind"], `${path}.security`);
      return {
        kind,
        projectId: validated(parsed.projectId, `${path}.projectId`, assertSafeProjectId),
        region: validated(parsed.region, `${path}.region`, assertSafeRegion),
        name: safeText(parsed.name, `${path}.name`, 63),
        network: safeText(parsed.network, `${path}.network`, 253),
        sizeGb: integer(parsed.sizeGb, `${path}.sizeGb`, 1, 300),
        tier: oneOf(parsed.tier, ["BASIC", "STANDARD_HA"] as const, `${path}.tier`),
        security: {
          kind: oneOf(
            security.kind,
            ["auth-tls-required", "legacy-plaintext-explicit-opt-out"] as const,
            `${path}.security.kind`,
          ),
        },
      };
    }
    default:
      fail(`${path}.kind`, `unknown cache operation ${JSON.stringify(kind)}`);
  }
}

function parseCdn(value: unknown, path: string): CdnInvalidation {
  const parsed = object(value, path);
  const kind = string(parsed.kind, `${path}.kind`);
  switch (kind) {
    case "none":
      exactKeys(parsed, ["kind"], path);
      return { kind };
    case "external":
      exactKeys(parsed, ["kind", "lifecycle"], path);
      return {
        kind,
        lifecycle: literal(parsed.lifecycle, "operator-managed", `${path}.lifecycle`),
      };
    case "gcp-cloud-cdn":
      exactKeys(
        parsed,
        ["kind", "projectId", "addressName", "invalidation", "failurePolicy"],
        path,
      );
      return {
        kind,
        projectId: validated(parsed.projectId, `${path}.projectId`, assertSafeProjectId),
        addressName: safeText(parsed.addressName, `${path}.addressName`, 63),
        invalidation: literal(
          parsed.invalidation,
          "recorded-cache-tag-or-full-path",
          `${path}.invalidation`,
        ),
        failurePolicy: literal(parsed.failurePolicy, "warn", `${path}.failurePolicy`),
      };
    default:
      fail(`${path}.kind`, `unknown CDN operation ${JSON.stringify(kind)}`);
  }
}

function parseKubernetesObjectRef(value: unknown, path: string): KubernetesObjectRef {
  const parsed = object(value, path);
  exactKeys(parsed, ["apiVersion", "resource", "name", "namespace"], path);
  const apiVersion = string(parsed.apiVersion, `${path}.apiVersion`);
  if (!API_VERSION_RE.test(apiVersion)) fail(`${path}.apiVersion`, "invalid Kubernetes apiVersion");
  const resource = string(parsed.resource, `${path}.resource`);
  if (!RESOURCE_RE.test(resource)) fail(`${path}.resource`, "invalid Kubernetes resource name");
  const name = string(parsed.name, `${path}.name`);
  if (!DNS_SUBDOMAIN_RE.test(name)) fail(`${path}.name`, "invalid Kubernetes object name");
  const namespace = optionalString(parsed, "namespace", path, assertSafeNamespace);
  return { apiVersion, resource, name, ...(namespace ? { namespace } : {}) };
}

function parseKubernetesServiceRef(value: unknown, path: string): KubernetesServiceRef {
  const parsed = object(value, path);
  exactKeys(parsed, ["name", "namespace", "port"], path);
  const name = string(parsed.name, `${path}.name`);
  if (!DNS_SUBDOMAIN_RE.test(name)) fail(`${path}.name`, "invalid Kubernetes Service name");
  return {
    name,
    namespace: validated(parsed.namespace, `${path}.namespace`, assertSafeNamespace),
    port: integer(parsed.port, `${path}.port`, 1, 65_535),
  };
}

function parseConditionLocation(
  value: unknown,
  path: string,
): Extract<RoutingReadiness, { kind: "kubernetes-condition" }>["conditionsAt"] {
  const parsed = object(value, path);
  const kind = string(parsed.kind, `${path}.kind`);
  switch (kind) {
    case "object":
      exactKeys(parsed, ["kind"], path);
      return { kind };
    case "parents": {
      exactKeys(parsed, ["kind", "controllerName"], path);
      const controllerName = optionalString(parsed, "controllerName", path);
      return { kind, ...(controllerName ? { controllerName } : {}) };
    }
    case "ancestors":
      exactKeys(parsed, ["kind", "controllerName"], path);
      return { kind, controllerName: safeText(parsed.controllerName, `${path}.controllerName`) };
    default:
      fail(`${path}.kind`, `unknown condition location ${JSON.stringify(kind)}`);
  }
}

function parseRoutingReadiness(value: unknown, path: string): RoutingReadiness {
  const parsed = object(value, path);
  const kind = string(parsed.kind, `${path}.kind`);
  switch (kind) {
    case "kubernetes-condition": {
      exactKeys(parsed, ["kind", "object", "conditionsAt", "condition", "timeoutSeconds"], path);
      const condition = object(parsed.condition, `${path}.condition`);
      exactKeys(condition, ["type", "status", "observedGeneration"], `${path}.condition`);
      return {
        kind,
        object: parseKubernetesObjectRef(parsed.object, `${path}.object`),
        conditionsAt: parseConditionLocation(parsed.conditionsAt, `${path}.conditionsAt`),
        condition: {
          type: safeText(condition.type, `${path}.condition.type`, 63),
          status: literal(condition.status, "True", `${path}.condition.status`),
          observedGeneration: literal(
            condition.observedGeneration,
            "must-equal-metadata-generation",
            `${path}.condition.observedGeneration`,
          ),
        },
        timeoutSeconds: integer(parsed.timeoutSeconds, `${path}.timeoutSeconds`, 1, 3600),
      };
    }
    case "kubernetes-job-complete":
    case "kubernetes-deployment-available":
      exactKeys(parsed, ["kind", "object", "timeoutSeconds"], path);
      return {
        kind,
        object: parseKubernetesObjectRef(parsed.object, `${path}.object`),
        timeoutSeconds: integer(parsed.timeoutSeconds, `${path}.timeoutSeconds`, 1, 3600),
      };
    case "kubernetes-service-endpoints":
      exactKeys(parsed, ["kind", "service", "minimumReady"], path);
      return {
        kind,
        service: parseKubernetesServiceRef(parsed.service, `${path}.service`),
        minimumReady: integer(parsed.minimumReady, `${path}.minimumReady`, 1, 10_000),
      };
    case "gcp-traffic-extension":
      exactKeys(
        parsed,
        ["kind", "projectId", "extensionName", "addressName", "requireEveryForwardingRule"],
        path,
      );
      return {
        kind,
        projectId: validated(parsed.projectId, `${path}.projectId`, assertSafeProjectId),
        extensionName: safeText(parsed.extensionName, `${path}.extensionName`, 63),
        addressName: safeText(parsed.addressName, `${path}.addressName`, 63),
        requireEveryForwardingRule: literal(
          parsed.requireEveryForwardingRule,
          true,
          `${path}.requireEveryForwardingRule`,
        ),
      };
    default:
      fail(`${path}.kind`, `unknown routing readiness operation ${JSON.stringify(kind)}`);
  }
}

function parseRouting(value: unknown, path: string): RoutingPlan {
  const parsed = object(value, path);
  exactKeys(parsed, ["protocol", "failurePolicy", "dataplane"], path);
  const protocol = oneOf(
    parsed.protocol,
    ["pool-local-v1", "envoy-ext-proc-v3"] as const,
    `${path}.protocol`,
  );
  const dataplane = object(parsed.dataplane, `${path}.dataplane`);
  const kind = string(dataplane.kind, `${path}.dataplane.kind`);
  const readiness = (raw: unknown) =>
    array(raw, `${path}.dataplane.readiness`, parseRoutingReadiness, 64);
  if (protocol === "pool-local-v1") {
    if (kind !== "portable-http-origin") {
      fail(`${path}.dataplane.kind`, 'pool-local-v1 requires "portable-http-origin"');
    }
    exactKeys(dataplane, ["kind", "service", "readiness"], `${path}.dataplane`);
    return {
      protocol,
      failurePolicy: literal(parsed.failurePolicy, "closed", `${path}.failurePolicy`),
      dataplane: {
        kind,
        service: parseKubernetesServiceRef(dataplane.service, `${path}.dataplane.service`),
        readiness: readiness(dataplane.readiness),
      },
    };
  }
  let parsedDataplane: RoutingPlan["dataplane"];
  switch (kind) {
    case "external-ext-proc":
      exactKeys(dataplane, ["kind", "transport", "readiness"], `${path}.dataplane`);
      parsedDataplane = {
        kind,
        transport: oneOf(
          dataplane.transport,
          ["tls", "h2c"] as const,
          `${path}.dataplane.transport`,
        ),
        readiness: readiness(dataplane.readiness),
      };
      break;
    case "adapter-owned-envoy-proxy":
      exactKeys(dataplane, ["kind", "service", "readiness"], `${path}.dataplane`);
      parsedDataplane = {
        kind,
        service: parseKubernetesServiceRef(dataplane.service, `${path}.dataplane.service`),
        readiness: readiness(dataplane.readiness),
      };
      break;
    default:
      fail(`${path}.dataplane.kind`, `unknown routing dataplane operation ${JSON.stringify(kind)}`);
  }
  return {
    protocol,
    failurePolicy: oneOf(
      parsed.failurePolicy,
      ["open", "closed"] as const,
      `${path}.failurePolicy`,
    ),
    dataplane: parsedDataplane,
  };
}

function parseKubernetesOwnedObject(value: unknown, path: string): KubernetesOwnedObject {
  const parsed = object(value, path);
  exactKeys(parsed, ["ref", "lifecycle", "ownership"], path);
  const ownership = object(parsed.ownership, `${path}.ownership`);
  exactKeys(ownership, ["releaseLabel", "helmRelease"], `${path}.ownership`);
  const releaseLabel = object(ownership.releaseLabel, `${path}.ownership.releaseLabel`);
  exactKeys(releaseLabel, ["key", "value"], `${path}.ownership.releaseLabel`);
  const helmRelease = Object.hasOwn(ownership, "helmRelease")
    ? object(ownership.helmRelease, `${path}.ownership.helmRelease`)
    : undefined;
  if (helmRelease) {
    exactKeys(helmRelease, ["name", "namespace"], `${path}.ownership.helmRelease`);
  }
  return {
    ref: parseKubernetesObjectRef(parsed.ref, `${path}.ref`),
    lifecycle: oneOf(
      parsed.lifecycle,
      ["helm", "retain-with-build", "retain-with-pool"] as const,
      `${path}.lifecycle`,
    ),
    ownership: {
      releaseLabel: {
        key: literal(
          releaseLabel.key,
          "adapter-k8s.dev/release",
          `${path}.ownership.releaseLabel.key`,
        ),
        value: validated(
          releaseLabel.value,
          `${path}.ownership.releaseLabel.value`,
          assertSafeReleaseName,
        ),
      },
      ...(helmRelease
        ? {
            helmRelease: {
              name: validated(
                helmRelease.name,
                `${path}.ownership.helmRelease.name`,
                assertSafeReleaseName,
              ),
              namespace: validated(
                helmRelease.namespace,
                `${path}.ownership.helmRelease.namespace`,
                assertSafeNamespace,
              ),
            },
          }
        : {}),
    },
  };
}

function parseExternalCleanup(value: unknown, path: string): ExternalCleanupOperation {
  const parsed = object(value, path);
  const kind = string(parsed.kind, `${path}.kind`);
  const projectId = () => validated(parsed.projectId, `${path}.projectId`, assertSafeProjectId);
  switch (kind) {
    case "gcp-storage-bucket":
      exactKeys(parsed, ["kind", "projectId", "bucket"], path);
      return {
        kind,
        projectId: projectId(),
        bucket: validated(parsed.bucket, `${path}.bucket`, assertSafeBucketName),
      };
    case "gcp-service-account": {
      exactKeys(parsed, ["kind", "projectId", "email"], path);
      const email = string(parsed.email, `${path}.email`);
      if (!SERVICE_ACCOUNT_EMAIL_RE.test(email)) {
        fail(`${path}.email`, "invalid Google service-account email");
      }
      return { kind, projectId: projectId(), email };
    }
    case "gcp-memorystore":
      exactKeys(parsed, ["kind", "projectId", "region", "name"], path);
      return {
        kind,
        projectId: projectId(),
        region: validated(parsed.region, `${path}.region`, assertSafeRegion),
        name: safeText(parsed.name, `${path}.name`, 63),
      };
    case "gcp-traffic-extension":
      exactKeys(parsed, ["kind", "projectId", "name", "location"], path);
      return {
        kind,
        projectId: projectId(),
        name: safeText(parsed.name, `${path}.name`, 63),
        location: literal(parsed.location, "global", `${path}.location`),
      };
    case "gcp-backend-service":
    case "gcp-health-check":
      exactKeys(parsed, ["kind", "projectId", "name", "scope"], path);
      return {
        kind,
        projectId: projectId(),
        name: safeText(parsed.name, `${path}.name`, 63),
        scope: literal(parsed.scope, "global", `${path}.scope`),
      };
    case "gcp-global-address":
      exactKeys(parsed, ["kind", "projectId", "name"], path);
      return { kind, projectId: projectId(), name: safeText(parsed.name, `${path}.name`, 63) };
    case "gcp-custom-iam-role":
      exactKeys(parsed, ["kind", "projectId", "roleId"], path);
      return {
        kind,
        projectId: projectId(),
        roleId: safeText(parsed.roleId, `${path}.roleId`, 64),
      };
    default:
      fail(`${path}.kind`, `unknown cleanup operation ${JSON.stringify(kind)}`);
  }
}

function parseRetainedExternal(value: unknown, path: string): RetainedExternalResource {
  const parsed = object(value, path);
  const kind = string(parsed.kind, `${path}.kind`);
  switch (kind) {
    case "gke-cluster":
      exactKeys(parsed, ["kind", "projectId", "clusterName", "location"], path);
      return {
        kind,
        projectId: validated(parsed.projectId, `${path}.projectId`, assertSafeProjectId),
        clusterName: safeText(parsed.clusterName, `${path}.clusterName`, 63),
        location: parseGcpLocation(parsed.location, `${path}.location`),
      };
    case "gcp-artifact-registry":
      exactKeys(parsed, ["kind", "projectId", "region", "repository"], path);
      return {
        kind,
        projectId: validated(parsed.projectId, `${path}.projectId`, assertSafeProjectId),
        region: validated(parsed.region, `${path}.region`, assertSafeRegion),
        repository: safeText(parsed.repository, `${path}.repository`, 63),
      };
    case "gcp-certificate-manager":
      exactKeys(parsed, ["kind", "projectId", "releasePrefix"], path);
      return {
        kind,
        projectId: validated(parsed.projectId, `${path}.projectId`, assertSafeProjectId),
        releasePrefix: validated(
          parsed.releasePrefix,
          `${path}.releasePrefix`,
          assertSafeReleaseName,
        ),
      };
    default:
      fail(`${path}.kind`, `unknown retained-resource operation ${JSON.stringify(kind)}`);
  }
}

function parseCleanup(value: unknown, path: string): CleanupPlan {
  const parsed = object(value, path);
  exactKeys(parsed, ["kubernetes", "external", "retained"], path);
  const kubernetes = object(parsed.kubernetes, `${path}.kubernetes`);
  exactKeys(kubernetes, ["strategy", "contributedObjects"], `${path}.kubernetes`);
  return {
    kubernetes: {
      strategy: literal(kubernetes.strategy, "adapter-release-v1", `${path}.kubernetes.strategy`),
      contributedObjects: array(
        kubernetes.contributedObjects,
        `${path}.kubernetes.contributedObjects`,
        parseKubernetesOwnedObject,
      ),
    },
    external: array(parsed.external, `${path}.external`, parseExternalCleanup),
    retained: array(parsed.retained, `${path}.retained`, parseRetainedExternal),
  };
}

function parseDiagnostic(value: unknown, path: string): DiagnosticSource {
  const parsed = object(value, path);
  const kind = string(parsed.kind, `${path}.kind`);
  const projectId = () => validated(parsed.projectId, `${path}.projectId`, assertSafeProjectId);
  switch (kind) {
    case "kubernetes-condition": {
      exactKeys(parsed, ["kind", "check", "label"], path);
      const check = parseRoutingReadiness(parsed.check, `${path}.check`);
      if (check.kind !== "kubernetes-condition") {
        fail(`${path}.check.kind`, 'expected "kubernetes-condition"');
      }
      return { kind, check, label: safeText(parsed.label, `${path}.label`, 120) };
    }
    case "kubernetes-gateway-address":
      exactKeys(parsed, ["kind", "gateway"], path);
      return { kind, gateway: parseKubernetesObjectRef(parsed.gateway, `${path}.gateway`) };
    case "gcp-auth":
      exactKeys(parsed, ["kind", "projectId"], path);
      return { kind, projectId: projectId() };
    case "gcp-global-address":
      exactKeys(parsed, ["kind", "projectId", "name"], path);
      return { kind, projectId: projectId(), name: safeText(parsed.name, `${path}.name`, 63) };
    case "gcp-storage-bucket":
      exactKeys(parsed, ["kind", "projectId", "bucket"], path);
      return {
        kind,
        projectId: projectId(),
        bucket: validated(parsed.bucket, `${path}.bucket`, assertSafeBucketName),
      };
    case "gcp-artifact-registry":
      exactKeys(parsed, ["kind", "projectId", "region", "repository"], path);
      return {
        kind,
        projectId: projectId(),
        region: validated(parsed.region, `${path}.region`, assertSafeRegion),
        repository: safeText(parsed.repository, `${path}.repository`, 63),
      };
    case "gcp-backend-health":
      exactKeys(parsed, ["kind", "projectId", "releasePrefix"], path);
      return {
        kind,
        projectId: projectId(),
        releasePrefix: validated(
          parsed.releasePrefix,
          `${path}.releasePrefix`,
          assertSafeReleaseName,
        ),
      };
    case "gcp-traffic-extension":
      exactKeys(parsed, ["kind", "projectId", "extensionName", "addressName"], path);
      return {
        kind,
        projectId: projectId(),
        extensionName: safeText(parsed.extensionName, `${path}.extensionName`, 63),
        addressName: safeText(parsed.addressName, `${path}.addressName`, 63),
      };
    case "gcp-backend-service-shape":
      exactKeys(
        parsed,
        ["kind", "projectId", "name", "loadBalancingScheme", "requireBackend"],
        path,
      );
      return {
        kind,
        projectId: projectId(),
        name: safeText(parsed.name, `${path}.name`, 63),
        loadBalancingScheme: literal(
          parsed.loadBalancingScheme,
          "EXTERNAL_MANAGED",
          `${path}.loadBalancingScheme`,
        ),
        requireBackend: literal(parsed.requireBackend, true, `${path}.requireBackend`),
      };
    case "gcp-health-check-shape":
      exactKeys(parsed, ["kind", "projectId", "name", "expectedType"], path);
      return {
        kind,
        projectId: projectId(),
        name: safeText(parsed.name, `${path}.name`, 63),
        expectedType: literal(parsed.expectedType, "TCP", `${path}.expectedType`),
      };
    case "gcp-certificate":
      exactKeys(parsed, ["kind", "projectId", "name"], path);
      return { kind, projectId: projectId(), name: safeText(parsed.name, `${path}.name`, 63) };
    default:
      fail(`${path}.kind`, `unknown diagnostic operation ${JSON.stringify(kind)}`);
  }
}

function parseLog(value: unknown, path: string): LogSource {
  const parsed = object(value, path);
  const kind = string(parsed.kind, `${path}.kind`);
  if (kind !== "kubernetes-pods") {
    fail(`${path}.kind`, `unknown log operation ${JSON.stringify(kind)}`);
  }
  exactKeys(parsed, ["kind", "namespace", "selector", "containers"], path);
  const selector = object(parsed.selector, `${path}.selector`);
  exactKeys(selector, ["releaseName"], `${path}.selector`);
  return {
    kind,
    namespace: validated(parsed.namespace, `${path}.namespace`, assertSafeNamespace),
    selector: {
      releaseName: validated(
        selector.releaseName,
        `${path}.selector.releaseName`,
        assertSafeReleaseName,
      ),
    },
    containers: literal(parsed.containers, "all", `${path}.containers`),
  };
}

function parseKubernetesRequirement(value: unknown, path: string): KubernetesApiRequirement {
  const parsed = object(value, path);
  exactKeys(parsed, ["apiVersion", "resource", "optional"], path);
  const apiVersion = string(parsed.apiVersion, `${path}.apiVersion`);
  if (!API_VERSION_RE.test(apiVersion)) fail(`${path}.apiVersion`, "invalid Kubernetes apiVersion");
  const resource = string(parsed.resource, `${path}.resource`);
  if (!RESOURCE_RE.test(resource)) fail(`${path}.resource`, "invalid Kubernetes resource name");
  if (typeof parsed.optional !== "boolean") fail(`${path}.optional`, "expected a boolean");
  return { apiVersion, resource, optional: parsed.optional };
}

function parseKubernetesJson(value: unknown, path: string, depth = 0): KubernetesJsonValue {
  if (depth > 64) fail(path, "exceeded maximum Kubernetes object depth of 64");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "expected a finite JSON number");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1024) fail(path, "expected at most 1024 array entries");
    return value.map((entry, index) => parseKubernetesJson(entry, `${path}[${index}]`, depth + 1));
  }
  const parsed = object(value, path);
  const result: Record<string, KubernetesJsonValue> = {};
  for (const [entryKey, entry] of Object.entries(parsed)) {
    result[entryKey] = parseKubernetesJson(entry, `${path}.${entryKey}`, depth + 1);
  }
  return result;
}

function parseStringMap(value: unknown, path: string): Record<string, string> {
  const parsed = object(value, path);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (!isSafeMapKey(key) || typeof entry !== "string") {
      fail(path, "expected printable string keys and string values");
    }
    result[key] = safeText(entry, `${path}.${key}`, 4096);
  }
  return result;
}

function isSafeMapKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  );
}

function parseKubernetesManifest(value: unknown, path: string): KubernetesManifest {
  const parsed = object(value, path);
  exactKeys(parsed, ["apiVersion", "kind", "resource", "metadata", "body"], path);
  const apiVersion = string(parsed.apiVersion, `${path}.apiVersion`);
  if (!API_VERSION_RE.test(apiVersion)) fail(`${path}.apiVersion`, "invalid Kubernetes apiVersion");
  const kind = safeText(parsed.kind, `${path}.kind`, 63);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(kind)) fail(`${path}.kind`, "invalid Kubernetes kind");
  if (kind === "Secret") {
    fail(`${path}.kind`, "build-time resource hooks cannot emit Secrets into composition plans");
  }
  const resource = string(parsed.resource, `${path}.resource`);
  if (!RESOURCE_RE.test(resource)) fail(`${path}.resource`, "invalid Kubernetes resource name");
  const metadata = object(parsed.metadata, `${path}.metadata`);
  exactKeys(metadata, ["name", "namespace", "labels", "annotations"], `${path}.metadata`);
  const name = string(metadata.name, `${path}.metadata.name`);
  if (!DNS_SUBDOMAIN_RE.test(name)) fail(`${path}.metadata.name`, "invalid Kubernetes object name");
  const namespace = optionalString(metadata, "namespace", `${path}.metadata`, assertSafeNamespace);
  const labels = Object.hasOwn(metadata, "labels")
    ? parseStringMap(metadata.labels, `${path}.metadata.labels`)
    : undefined;
  const annotations = Object.hasOwn(metadata, "annotations")
    ? parseStringMap(metadata.annotations, `${path}.metadata.annotations`)
    : undefined;
  const body = Object.hasOwn(parsed, "body")
    ? (parseKubernetesJson(parsed.body, `${path}.body`) as Record<string, KubernetesJsonValue>)
    : undefined;
  if (body && ["apiVersion", "kind", "metadata", "status"].some((key) => key in body)) {
    fail(`${path}.body`, "cannot replace identity fields or declare status");
  }
  return {
    apiVersion,
    kind,
    resource,
    metadata: {
      name,
      ...(namespace ? { namespace } : {}),
      ...(labels ? { labels } : {}),
      ...(annotations ? { annotations } : {}),
    },
    ...(body ? { body } : {}),
  };
}

function parseVersion(version: string, path: string): [number, number, number] {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) fail(path, "expected a semantic version such as 1.33.0");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < 3; index++) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function assertKubernetesMinimumVersion(version: string): void {
  if (
    compareVersion(
      parseVersion(version, "$.requirements.kubernetes.minimumVersion"),
      parseVersion(MINIMUM_KUBERNETES_VERSION, "minimum supported Kubernetes version"),
    ) < 0
  ) {
    fail(
      "$.requirements.kubernetes.minimumVersion",
      `adapter-k8s requires Kubernetes ${MINIMUM_KUBERNETES_VERSION} or newer`,
    );
  }
}

export function assertKubernetesServerVersion(
  actualVersion: string,
  requiredVersion: string = MINIMUM_KUBERNETES_VERSION,
): void {
  assertKubernetesMinimumVersion(requiredVersion);
  if (
    compareVersion(
      parseVersion(actualVersion, "Kubernetes server version"),
      parseVersion(requiredVersion, "required Kubernetes version"),
    ) < 0
  ) {
    throw new Error(
      `Kubernetes server ${actualVersion} is older than the composition plan requirement ${requiredVersion}`,
    );
  }
}

export function parseCompositionPlan(value: unknown): CompositionPlan {
  const parsed = object(value, "$");
  exactKeys(
    parsed,
    ["apiVersion", "kind", "metadata", "target", "requirements", "operations"],
    "$",
  );

  const metadata = object(parsed.metadata, "$.metadata");
  exactKeys(metadata, ["releaseName", "namespace", "buildId"], "$.metadata");

  const target = object(parsed.target, "$.target");
  exactKeys(target, ["fingerprint", "identity", "access", "registry"], "$.target");
  const fingerprint = string(target.fingerprint, "$.target.fingerprint");
  if (!DIGEST_RE.test(fingerprint)) {
    fail("$.target.fingerprint", "expected sha256:<64 lowercase hex characters>");
  }

  const requirements = object(parsed.requirements, "$.requirements");
  exactKeys(requirements, ["kubernetes"], "$.requirements");
  const kubernetes = object(requirements.kubernetes, "$.requirements.kubernetes");
  exactKeys(kubernetes, ["minimumVersion", "resources"], "$.requirements.kubernetes");
  const minimumVersion = string(
    kubernetes.minimumVersion,
    "$.requirements.kubernetes.minimumVersion",
  );
  assertKubernetesMinimumVersion(minimumVersion);

  const operations = object(parsed.operations, "$.operations");
  exactKeys(
    operations,
    ["resources", "network", "cache", "cdn", "routing", "cleanup", "diagnostics", "logs"],
    "$.operations",
  );
  const resourceOperations = object(operations.resources, "$.operations.resources");
  exactKeys(resourceOperations, ["objects", "readiness"], "$.operations.resources");

  const releaseName = validated(
    metadata.releaseName,
    "$.metadata.releaseName",
    assertSafeReleaseName,
  );
  const namespace = validated(metadata.namespace, "$.metadata.namespace", assertSafeNamespace);
  const buildId = validated(metadata.buildId, "$.metadata.buildId", assertSafeBuildId);

  const plan: CompositionPlan = {
    apiVersion: literal(parsed.apiVersion, COMPOSITION_PLAN_API_VERSION, "$.apiVersion"),
    kind: literal(parsed.kind, COMPOSITION_PLAN_KIND, "$.kind"),
    metadata: { releaseName, namespace, buildId },
    target: {
      fingerprint: fingerprint as CompositionPlan["target"]["fingerprint"],
      identity: parseClusterIdentity(target.identity, "$.target.identity"),
      access: parseClusterAccess(target.access, "$.target.access"),
      registry: parseRegistry(target.registry, "$.target.registry"),
    },
    requirements: {
      kubernetes: {
        minimumVersion,
        resources: array(
          kubernetes.resources,
          "$.requirements.kubernetes.resources",
          parseKubernetesRequirement,
        ),
      },
    },
    operations: {
      resources: {
        objects: array(
          resourceOperations.objects,
          "$.operations.resources.objects",
          parseKubernetesManifest,
        ),
        readiness: array(
          resourceOperations.readiness,
          "$.operations.resources.readiness",
          parseRoutingReadiness,
        ),
      },
      network: parseNetwork(operations.network, "$.operations.network"),
      cache: parseCache(operations.cache, "$.operations.cache"),
      cdn: parseCdn(operations.cdn, "$.operations.cdn"),
      routing: parseRouting(operations.routing, "$.operations.routing"),
      cleanup: parseCleanup(operations.cleanup, "$.operations.cleanup"),
      diagnostics: array(operations.diagnostics, "$.operations.diagnostics", parseDiagnostic),
      logs: array(operations.logs, "$.operations.logs", parseLog),
    },
  };

  for (const [path, candidate] of [
    ["$.operations.logs", plan.operations.logs.map((source) => source.namespace)],
    [
      "$.operations.cleanup.kubernetes.contributedObjects",
      plan.operations.cleanup.kubernetes.contributedObjects
        .map((entry) => entry.ref.namespace)
        .filter((entry): entry is string => entry !== undefined),
    ],
    [
      "$.operations.resources.objects",
      plan.operations.resources.objects
        .map((entry) => entry.metadata.namespace)
        .filter((entry): entry is string => entry !== undefined),
    ],
  ] as const) {
    const mismatched = candidate.filter((entry) => entry !== namespace);
    if (mismatched.length > 0)
      fail(path, `all release-scoped objects must use namespace ${namespace}`);
  }

  for (const source of plan.operations.logs) {
    if (source.selector.releaseName !== releaseName) {
      fail("$.operations.logs", `all log selectors must use release ${releaseName}`);
    }
  }
  for (const owned of plan.operations.cleanup.kubernetes.contributedObjects) {
    if (owned.ownership.releaseLabel.value !== releaseName) {
      fail(
        "$.operations.cleanup.kubernetes.contributedObjects",
        `all ownership labels must use release ${releaseName}`,
      );
    }
  }

  return plan;
}
