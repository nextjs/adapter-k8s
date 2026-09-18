import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { execCapture, execCaptureStdin, EXEC_TIMEOUTS } from "../cli/exec.js";
import {
  assertSafeBuildId,
  assertSafeNamespace,
  assertSafeReleaseName,
  sanitizeK8sName,
} from "../emit/templates/utils.js";
import { internalSecretName, INTERNAL_SECRET_KEY } from "../emit/templates/internal-secret.js";
import { retentionName } from "../emit/templates/retention.js";
import { setRetentionExpiry } from "./retention-expiry.js";
import {
  RETENTION_MAX_BYTES,
  signRetention,
  inventorySignature,
  validateInventory,
  type RetainedBuild,
} from "../retention.js";

/** Register exactly the incoming and outgoing builds before switching any selector. */
export async function prepareRetention(
  releaseName: string,
  namespace: string,
  incoming: string,
  outgoing: string | null,
): Promise<{ complete: () => Promise<void> } | null> {
  assertSafeReleaseName(releaseName);
  assertSafeNamespace(namespace);
  assertSafeBuildId(incoming);
  if (!outgoing) return null;
  assertSafeBuildId(outgoing);
  const read = async (kind: string, name: string) => {
    const result = await execCapture(
      "kubectl",
      ["get", kind, name, "-n", namespace, "--ignore-not-found", "-o", "json"],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (result.exitCode !== 0)
      throw new Error(`Could not read ${kind} ${name} for build retention`);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };
  const builds: RetainedBuild[] = [];
  const inventoryProofs = new Map<string, { payload: string; signature: string }>();
  const secrets = new Map<string, string>();
  for (const buildId of [incoming, outgoing]) {
    const object = await read("configmap", retentionName(releaseName, buildId));
    if (!object?.data?.["inventory.json"]) return null; // The feature starts after two opted-in builds.
    const inventory = JSON.parse(object.data["inventory.json"]);
    inventoryProofs.set(buildId, {
      payload: object.data["inventory.json"],
      signature: object.data.signature,
    });
    validateInventory(inventory);
    if (
      inventory.buildId !== buildId ||
      object.metadata?.name !== retentionName(releaseName, buildId) ||
      object.metadata?.labels?.["app.kubernetes.io/name"] !== releaseName
    )
      throw new Error("Retained inventory ownership mismatch");
    builds.push({
      ...inventory,
      origin: `http://${sanitizeK8sName(`${releaseName}-${inventory.defaultPool}-${buildId}`)}:3000`,
      expiresAt: 0,
    });
  }
  if (
    JSON.stringify([...builds[0]!.pools].sort()) !== JSON.stringify([...builds[1]!.pools].sort())
  ) {
    console.warn(
      "  ! Build retention is unavailable across a pool topology change; parking the previous build normally",
    );
    return null;
  }
  // Preparation covers bounded backend warming. After state commits, complete()
  // publishes the configured grace period plus projection allowance. An interrupted
  // CLI leaves a finite one-hour ceiling enforced by the readers themselves.
  const expiresAt = Date.now() + 3_600_000;
  for (const build of builds) build.expiresAt = expiresAt;
  const previousIndex = await read("configmap", retentionName(releaseName));
  if (
    previousIndex &&
    previousIndex.metadata?.labels?.["app.kubernetes.io/managed-by"] !== "adapter-k8s"
  ) {
    throw new Error("Refusing to replace an unowned retention index");
  }
  const previousRecords = JSON.parse(previousIndex?.data?.["index.json"] ?? "{}");
  const index: Record<string, ReturnType<typeof signRetention>> = Object.create(null);
  for (const build of builds) {
    const object = await read("secret", internalSecretName(releaseName, build.buildId));
    const encoded = object?.data?.[INTERNAL_SECRET_KEY];
    if (typeof encoded !== "string")
      throw new Error("Retained build dispatch secret is unavailable");
    const secret = Buffer.from(encoded, "base64").toString("utf8");
    if (!secret) throw new Error("Retained build dispatch secret is empty");
    const proof = inventoryProofs.get(build.buildId)!;
    if (inventorySignature(proof.payload, secret) !== proof.signature)
      throw new Error("Retained inventory signature is invalid");
    secrets.set(build.buildId, secret);
    index[build.buildId] = signRetention(builds, secret);
    // While the candidate warms, the serving build must still reach its PREVIOUS
    // build. Preserve that receiver's verified record. The candidate's record selects
    // only the outgoing build, so after cutover this does not extend public history.
    const prior = previousRecords[build.buildId];
    if (build.buildId === outgoing && typeof prior?.payload === "string") {
      try {
        const priorBuilds = JSON.parse(prior.payload);
        if (signRetention(priorBuilds, secret).signature === prior.signature)
          index[build.buildId] = prior;
      } catch {
        /* Replace corrupt prior state with the newly verified inventories. */
      }
    }
  }
  const json = JSON.stringify(index);
  if (Buffer.byteLength(json) > RETENTION_MAX_BYTES)
    throw new Error("Combined retention index exceeds 800KB");
  const applied = await execCaptureStdin(
    "kubectl",
    [previousIndex ? "replace" : "create", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: retentionName(releaseName),
        namespace,
        ...(previousIndex ? { resourceVersion: previousIndex.metadata.resourceVersion } : {}),
        labels: {
          "app.kubernetes.io/name": releaseName,
          "app.kubernetes.io/component": "retention-index",
          "app.kubernetes.io/managed-by": "adapter-k8s",
        },
      },
      data: { "index.json": json },
    }),
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (applied.exitCode !== 0) throw new Error("Could not publish retained build index");

  async function waitForIndex(document: string) {
    const digest = createHash("sha256").update(document).digest("hex");
    const deadline = Date.now() + 120_000;
    const versions = new Set(builds.map((build) => sanitizeK8sName(build.buildId)));
    for (;;) {
      const result = await execCapture(
        "kubectl",
        [
          "get",
          "pods",
          "-n",
          namespace,
          "-l",
          `app.kubernetes.io/name=${releaseName}`,
          "-o",
          "json",
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (result.exitCode !== 0) throw new Error("Could not verify retention index propagation");
      const pods = JSON.parse(result.stdout).items;
      let checked = 0;
      let ready = true;
      for (const pod of pods) {
        if (
          !versions.has(pod.metadata?.labels?.["app.kubernetes.io/version"]) ||
          pod.metadata.deletionTimestamp
        )
          continue;
        if (
          !pod.status?.conditions?.some(
            (c: { type: string; status: string }) => c.type === "Ready" && c.status === "True",
          )
        )
          continue;
        const container = pod.spec?.containers?.find(
          (c: { name: string }) => c.name === "pool-server" || c.name === "routing-service",
        );
        if (!container || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(pod.metadata.name)) continue;
        if (Date.now() >= deadline)
          throw new Error("Retention projection check exceeded its deadline");
        checked++;
        const probe = await execCapture(
          "kubectl",
          [
            "exec",
            pod.metadata.name,
            "-n",
            namespace,
            "-c",
            container.name,
            "--",
            "node",
            "-e",
            'try { const b=require("node:fs").readFileSync("/retention/index.json"); process.exit(require("node:crypto").createHash("sha256").update(b).digest("hex") === process.argv[1] ? 0 : 1); } catch { process.exit(1); }',
            digest,
          ],
          { timeoutMs: Math.min(EXEC_TIMEOUTS.kubectl, Math.max(1, deadline - Date.now())) },
        );
        if (probe.exitCode !== 0) ready = false;
      }
      if (checked > 0 && ready) break;
      if (Date.now() >= deadline)
        throw new Error("Retention index did not reach ready pods before cutover");
      await delay(2000);
    }
    // A mounted file can be newer than a reader's 250ms in-memory cache.
    await delay(300);
  }
  await waitForIndex(json);
  // Arm before cutover: if the CLI dies after committing state, the cluster can
  // retire the standby at the finite preparation deadline. Active builds are protected.
  await setRetentionExpiry(releaseName, namespace, outgoing, builds[1]!.pools, expiresAt);
  console.log(
    `  → Previous build remains routable until ${new Date(expiresAt).toISOString()}; one standby replica per pool`,
  );
  return {
    complete: async () => {
      try {
        const current = await read("configmap", retentionName(releaseName));
        if (current?.data?.["index.json"] !== json)
          throw new Error("A newer promotion replaced the retention index");
        const finalExpiresAt = Date.now() + (builds[0]!.gracePeriodSeconds + 120) * 1000;
        index[incoming] = signRetention(
          builds.map((build) => ({ ...build, expiresAt: finalExpiresAt })),
          secrets.get(incoming)!,
        );
        current.data["index.json"] = JSON.stringify(index);
        const updated = await execCaptureStdin(
          "kubectl",
          ["replace", "-f", "-"],
          JSON.stringify(current),
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (updated.exitCode !== 0) throw new Error("Could not finalize retention deadline");
        await waitForIndex(current.data["index.json"]);
        await setRetentionExpiry(
          releaseName,
          namespace,
          outgoing,
          builds[1]!.pools,
          finalExpiresAt,
        );
        console.log(
          `  → Retained build serving deadline: ${new Date(finalExpiresAt).toISOString()}`,
        );
      } catch (error) {
        console.warn(
          `  ! ${error instanceof Error ? error.message : "Retention finalization failed"}; the preparatory index expires within one hour`,
        );
      }
    },
  };
}
