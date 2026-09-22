import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { execCapture, EXEC_TIMEOUTS, type ExecCaptureResult } from "../cli/exec.js";
import {
  assertSafeAnnotationName,
  assertSafeGcpResourceName,
  assertSafeKubernetesObjectName,
  assertSafeNamespace,
  assertSafeServiceName,
} from "../emit/templates/utils.js";
import { GkeBackends } from "./gke-backends.js";

type Selector = Record<string, string>;
interface Pod {
  metadata: { name: string; uid: string; deletionTimestamp?: string };
  status: { podIP: string; conditions?: { type: string; status: string }[] };
}
const VERSION = "app.kubernetes.io/version";
const COMPONENT = "app.kubernetes.io/component";
const WARMUP_MS = 300_000;
const STABLE_MS = 30_000;
const RECOVERY_PATH = "/metadata/annotations/adapter-k8s.io~1backend-warmup";

function labelSelector(selector: Selector): string {
  if (!Object.keys(selector).length) throw new Error("Refusing an empty pod selector");
  return Object.entries(selector)
    .map(([key, value]) => {
      assertSafeAnnotationName(key);
      if (!/^(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?)?$/.test(value))
        throw new Error("Invalid pod selector value");
      return `${key}=${value}`;
    })
    .join(",");
}

/** A CAS on the complete selector also protects against simultaneous deploy/rollback commands. */
async function replace(
  namespace: string,
  service: string,
  from: Selector,
  to: Selector,
  extra: { op: string; path: string; value?: string }[] = [],
): Promise<ExecCaptureResult> {
  return execCapture(
    "kubectl",
    [
      "patch",
      "service",
      service,
      "-n",
      namespace,
      "--type=json",
      "--field-manager=helm",
      "-p",
      JSON.stringify([
        { op: "test", path: "/spec/selector", value: from },
        { op: "replace", path: "/spec/selector", value: to },
        ...extra,
      ]),
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
}

/**
 * GKE updates its NEG asynchronously after a selector change. Admit a bounded set of
 * verified incoming pods while retaining outgoing endpoints, then require Compute health
 * before removing the old version. The temporary label selects only these exact pods,
 * including when a topology-changing rollback changes the destination component.
 * Generic Services retain the single CAS operation.
 */
export async function replaceServiceSelector(opts: {
  namespace: string;
  service: string;
  original: Selector;
  next: Selector;
  annotations?: Record<string, string> | undefined;
  projectId?: string | undefined;
}): Promise<ExecCaptureResult> {
  const { namespace, service, original, next, annotations, projectId } = opts;
  assertSafeNamespace(namespace);
  assertSafeServiceName(service);
  labelSelector(original);
  labelSelector(next);
  if (!annotations?.["cloud.google.com/neg"] && !annotations?.["cloud.google.com/neg-status"])
    return replace(namespace, service, original, next);

  // GKE's admission webhook adds {ingress:true} to internal ClusterIP Services
  // too. That marker alone creates no NEG. Standalone exposed ports or an
  // observed NEG still require backend health and fail closed if incomplete.
  if (!annotations?.["cloud.google.com/neg-status"]) {
    try {
      const requested: unknown = JSON.parse(annotations?.["cloud.google.com/neg"] ?? "null");
      if (
        requested &&
        typeof requested === "object" &&
        !Array.isArray(requested) &&
        Object.keys(requested).length === 1 &&
        "ingress" in requested &&
        requested.ingress === true
      ) {
        return replace(namespace, service, original, next);
      }
    } catch {
      // Malformed annotations take the existing fail-closed verification path.
    }
  }

  const key = `adapter-k8s.io/warm-${randomUUID().replaceAll("-", "")}`;
  const labelPath = `/metadata/labels/${key.replaceAll("/", "~1")}`;
  const overlap = { ...original, [key]: "1" };
  delete overlap[VERSION];
  delete overlap[COMPONENT];
  const labelled: Pod[] = [];
  // Keep an exact recovery snapshot on the Service if the process/Job is killed during
  // overlap. Both builds remain selected; operators can restore without guessing a
  // topology-changing rollback's original component or custom selector constraints.
  const recovery = JSON.stringify({ original, next, label: key });
  const clearRecovery = [
    { op: "test", path: RECOVERY_PATH, value: recovery },
    { op: "remove", path: RECOVERY_PATH },
  ];
  let overlapAttempted = false;
  let mayCleanLabels = true;
  const list = async (selector: Selector): Promise<Pod[]> => {
    const result = await execCapture(
      "kubectl",
      ["get", "pods", "-n", namespace, "-l", labelSelector(selector), "-o", "json"],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (result.exitCode !== 0) throw new Error(`Could not list pods for ${service}`);
    const pods = JSON.parse(result.stdout).items as Pod[];
    if (!Array.isArray(pods) || pods.length > 1000)
      throw new Error("Invalid or excessive cutover pod set");
    return pods;
  };
  const ready = (pod: Pod) =>
    !pod.metadata.deletionTimestamp &&
    pod.status.conditions?.some((c) => c.type === "Ready" && c.status === "True");
  const cleanup = async () => {
    for (const pod of labelled) {
      const result = await execCapture(
        "kubectl",
        [
          "patch",
          "pod",
          pod.metadata.name,
          "-n",
          namespace,
          "--type=json",
          "-p",
          JSON.stringify([
            { op: "test", path: "/metadata/uid", value: pod.metadata.uid },
            { op: "test", path: labelPath, value: "1" },
            { op: "remove", path: labelPath },
          ]),
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (result.exitCode !== 0)
        console.warn(
          `  ! Could not remove temporary warm-up label from ${pod.metadata.name}; no Service selects it.`,
        );
    }
  };

  try {
    if (!projectId)
      throw new Error(
        `GKE Service ${service} requires a project identity for backend health verification`,
      );
    const backends = new GkeBackends(projectId);
    const status = JSON.parse(annotations?.["cloud.google.com/neg-status"] ?? "{}");
    const neg = status.network_endpoint_groups?.["3000"];
    assertSafeGcpResourceName(neg, "Service NEG name");
    // Discovery/authentication must succeed before admitting any new endpoints.
    const refs = await backends.discover(neg);
    if (!refs.length) throw new Error(`No load-balancer backend is attached to ${service}'s NEG`);
    const incoming = (await list(next)).filter(ready);
    if (!incoming.length) throw new Error(`No ready incoming pods for ${service}`);
    const outgoing = (await list(original)).filter(ready);
    for (const pod of new Map(
      [...outgoing, ...incoming].map((p) => [p.metadata.uid, p]),
    ).values()) {
      assertSafeKubernetesObjectName(pod.metadata.name, "cutover pod name");
      if (typeof pod.metadata.uid !== "string" || !pod.metadata.uid || !isIP(pod.status.podIP))
        throw new Error("Invalid cutover pod identity");
      // Record before patching: a lost API response may still have applied the label.
      labelled.push(pod);
      const result = await execCapture(
        "kubectl",
        [
          "patch",
          "pod",
          pod.metadata.name,
          "-n",
          namespace,
          "--type=json",
          "-p",
          JSON.stringify([
            { op: "test", path: "/metadata/uid", value: pod.metadata.uid },
            { op: "add", path: labelPath, value: "1" },
          ]),
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (result.exitCode !== 0)
        throw new Error(`Could not label cutover pod ${pod.metadata.name}`);
    }
    console.log(`  → Warming GKE backends for ${service} with outgoing endpoints retained...`);
    overlapAttempted = true;
    const staged = await replace(namespace, service, original, overlap, [
      { op: "add", path: RECOVERY_PATH, value: recovery },
    ]);
    if (staged.exitCode !== 0)
      throw new Error(`Could not stage GKE backend overlap for ${service}`);
    const deadline = Date.now() + WARMUP_MS;
    let healthySince: number | undefined;
    while (Date.now() < deadline) {
      const live = (await list(next)).filter(ready);
      if (
        !incoming.every((p) =>
          live.some((l) => l.metadata.uid === p.metadata.uid && l.status.podIP === p.status.podIP),
        )
      )
        throw new Error(`Incoming pod set changed while warming ${service}; retry cutover`);
      let healthy = true;
      for (const ref of refs) {
        const ips = await backends.healthy(ref, neg);
        if (!incoming.every((p) => ips.has(p.status.podIP))) healthy = false;
      }
      if (healthy) healthySince ??= Date.now();
      else healthySince = undefined;
      // Health observed by the control plane precedes propagation to individual GFEs.
      // Keep old endpoints available throughout this consecutive healthy interval.
      if (healthySince !== undefined && Date.now() - healthySince >= STABLE_MS) {
        const result = await replace(namespace, service, overlap, next, clearRecovery);
        if (result.exitCode !== 0)
          throw new Error(`Could not finish GKE selector cutover for ${service}`);
        await cleanup();
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new Error(
      `GKE backend health for ${service} did not stabilize within ${WARMUP_MS / 1000}s`,
    );
  } catch (error) {
    let detail = error instanceof Error ? error.message : String(error);
    if (overlapAttempted) {
      // A timed-out PATCH can have succeeded. Read back before restoring, and never
      // overwrite a third party's selector. Retain labels if recovery is uncertain.
      mayCleanLabels = false;
      const read = await execCapture(
        "kubectl",
        ["get", "service", service, "-n", namespace, "-o", "json"],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (read.exitCode === 0) {
        try {
          const current = JSON.parse(read.stdout).spec.selector as Selector;
          const equal = (a: Selector, b: Selector) =>
            Object.keys(a).length === Object.keys(b).length &&
            Object.entries(a).every(([k, v]) => b[k] === v);
          if (equal(current, original)) mayCleanLabels = true;
          else if (equal(current, overlap) || equal(current, next))
            mayCleanLabels =
              (
                await replace(
                  namespace,
                  service,
                  current,
                  original,
                  equal(current, overlap) ? clearRecovery : [],
                )
              ).exitCode === 0;
        } catch {
          /* Preserve the overlap if the live selector cannot be established. */
        }
      }
      if (!mayCleanLabels)
        detail += `; could not restore ${service}'s selector, leaving warm-up labels and both builds in place`;
    }
    if (mayCleanLabels) await cleanup();
    return { exitCode: 1, stdout: "", stderr: detail };
  }
}
