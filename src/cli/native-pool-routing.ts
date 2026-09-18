import type { CompositionPlan } from "../composition-plan/types.js";
import {
  isNativePoolRoutingRoute,
  isNativePoolRule,
  nativePoolRoutingRules,
} from "../emit/native-pool-routing.js";
import {
  assertSafeBuildId,
  assertSafeNamespace,
  assertSafePoolName,
  assertSafeReleaseName,
  sanitizeK8sName,
} from "../emit/templates/utils.js";
import { execCapture, EXEC_TIMEOUTS } from "./exec.js";
import type { AdapterState } from "./state.js";

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}

export interface NativePoolRoutingDecision {
  enabled: boolean;
  reason: string;
}

/** A build recipe is not evidence that a Service existed before this Helm sync. */
export async function inspectNativePoolRouting(options: {
  plan: CompositionPlan;
  state: AdapterState | null;
  previousBuildId: string | null;
  pools: string[];
  defaultPool: string;
  dryRun?: boolean;
}): Promise<NativePoolRoutingDecision> {
  const { plan, state, previousBuildId, pools, defaultPool, dryRun } = options;
  const fallback = (reason: string) => ({ enabled: false, reason });
  const routes = plan.operations.resources.objects.filter(isNativePoolRoutingRoute);
  if (routes.length === 0) return fallback("not configured for native owning-pool routing");
  if (dryRun) return fallback("dry-run does not verify live predecessor endpoints");
  if (!previousBuildId) return fallback("first install has no established pool Services");
  if (!state || state.buildId !== previousBuildId) {
    return fallback("no authoritative committed predecessor");
  }
  const previousPools = state.poolTopologies?.[previousBuildId];
  if (
    !previousPools ||
    state.defaultPools?.[previousBuildId] !== defaultPool ||
    [...previousPools].sort().join("\n") !== [...pools].sort().join("\n")
  ) {
    return fallback("pool topology/default changed or the predecessor topology is unknown");
  }
  const { releaseName, namespace } = plan.metadata;
  assertSafeReleaseName(releaseName);
  assertSafeNamespace(namespace);
  assertSafeBuildId(previousBuildId);
  assertSafePoolName(defaultPool);
  const destinations = new Map<string, string>([
    [sanitizeK8sName(`${releaseName}-origin`), defaultPool],
  ]);
  for (const route of routes) {
    for (const rule of nativePoolRoutingRules(route).filter(isNativePoolRule)) {
      const matches = records(record(rule).matches);
      const headers = matches.flatMap((match) => records(match.headers));
      const pool = headers.find((header) => header.name === "x-upstream-pool")?.value;
      const backends = records(record(rule).backendRefs);
      if (typeof pool !== "string" || !pools.includes(pool)) {
        return fallback("native rule has an unknown pool");
      }
      assertSafePoolName(pool);
      const service = sanitizeK8sName(`${releaseName}-${pool}`);
      if (backends.length !== 1 || backends[0]?.name !== service || backends[0]?.port !== 3000) {
        return fallback("native rule does not use the expected stable pool Service");
      }
      destinations.set(service, pool);
    }
  }
  if (destinations.size === 1) return fallback("no non-default pool rules");

  async function read(args: string[]): Promise<JsonRecord> {
    const result = await execCapture("kubectl", [...args, "-n", namespace, "-o", "json"], {
      timeoutMs: EXEC_TIMEOUTS.kubectl,
    });
    if (result.exitCode !== 0) throw new Error("cluster read failed");
    return record(JSON.parse(result.stdout));
  }

  for (const [serviceName, pool] of destinations) {
    try {
      const service = await read(["get", "service", serviceName]);
      const metadata = record(service.metadata);
      const spec = record(service.spec);
      const selector = record(spec.selector);
      const expected = {
        "app.kubernetes.io/name": releaseName,
        "app.kubernetes.io/component": pool,
        "app.kubernetes.io/version": sanitizeK8sName(previousBuildId),
      };
      if (
        typeof metadata.uid !== "string" ||
        metadata.uid.length === 0 ||
        metadata.deletionTimestamp ||
        metadata.name !== serviceName ||
        metadata.namespace !== namespace ||
        Object.keys(selector).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([key, value]) => selector[key] !== value) ||
        !records(spec.ports).some(
          (port) =>
            port.port === 3000 &&
            port.targetPort === 3000 &&
            (port.protocol === undefined || port.protocol === "TCP"),
        )
      )
        return fallback(`${serviceName} does not select its own committed predecessor pool`);

      const podList = await read([
        "get",
        "pods",
        "-l",
        Object.entries(expected)
          .map(([key, value]) => `${key}=${value}`)
          .join(","),
      ]);
      const pods = new Map(
        records(podList.items).flatMap((pod) => {
          const meta = record(pod.metadata);
          const status = record(pod.status);
          if (
            typeof meta.uid !== "string" ||
            meta.deletionTimestamp ||
            Object.entries(expected).some(([key, value]) => record(meta.labels)[key] !== value) ||
            !records(status.conditions).some(
              (condition) => condition.type === "Ready" && condition.status === "True",
            )
          )
            return [];
          return [
            [meta.uid, { name: meta.name, ips: records(status.podIPs).map((ip) => ip.ip) }],
          ] as const;
        }),
      );
      const slices = await read([
        "get",
        "endpointslices",
        "-l",
        `kubernetes.io/service-name=${serviceName}`,
      ]);
      const serviceSlices = records(slices.items);
      if (
        serviceSlices.some((slice) => {
          const meta = record(slice.metadata);
          return (
            record(meta.labels)["kubernetes.io/service-name"] !== serviceName ||
            !records(meta.ownerReferences).some(
              (owner) => owner.kind === "Service" && owner.uid === metadata.uid,
            ) ||
            !records(slice.ports).some(
              (port) =>
                port.port === 3000 && (port.protocol === undefined || port.protocol === "TCP"),
            )
          );
        })
      )
        return fallback(`${serviceName} EndpointSlices do not match the stable Service`);
      const endpoints = serviceSlices.flatMap((slice) => {
        return records(slice.endpoints).filter((endpoint) => {
          const conditions = record(endpoint.conditions);
          return conditions.ready !== false && conditions.terminating !== true;
        });
      });
      if (
        endpoints.length === 0 ||
        endpoints.some((endpoint) => {
          const ref = record(endpoint.targetRef);
          const pod = typeof ref.uid === "string" ? pods.get(ref.uid) : undefined;
          return (
            ref.kind !== "Pod" ||
            !pod ||
            ref.name !== pod.name ||
            !Array.isArray(endpoint.addresses) ||
            endpoint.addresses.length === 0 ||
            endpoint.addresses.some((address) => !pod.ips.includes(address))
          );
        })
      )
        return fallback(`${serviceName} has no verified ready predecessor endpoints`);
    } catch {
      return fallback(`could not verify ${serviceName}; retaining the origin fallback`);
    }
  }
  return { enabled: true, reason: "unchanged committed topology with ready stable pool Services" };
}
