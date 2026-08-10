// src/cutover/gates.ts
// GitOps PR2: the Phase D gate battery, moved verbatim from src/cli/deploy.ts step 7
// (7a/7a-bis/route-ext wait/EnvoyExtensionPolicy wait/7a-ter warm-up/7b readiness), plus
// rollback's pre-flip serving gate. Each gate is a named, individually testable function;
// the incident comments travel with the code they were written for (12-char prefix, N64,
// stale-Accepted, N67, S18, N32).
import { execCapture, EXEC_TIMEOUTS } from "../cli/exec.js";
import { sanitizeForTerminal } from "../cli/terminal.js";
import { poolResourceNames } from "../emit/templates/utils.js";
import { routingServiceDeploymentName } from "../emit/templates/routing-manifest-configmap.js";
import { POOL_READINESS_PATH } from "../emit/templates/deployment.js";
import { CutoverExitError, type CutoverDeps } from "./inputs.js";

/**
 * How long to wait for a Deployment rollout.
 *
 * 120s was arithmetically impossible against the chart's OWN rollout parameters and only ever
 * passed by luck. The emitted Deployments use `maxUnavailable: 0` with `minReadySeconds: 30` and a
 * `preStop: sleep 120` (N63, for load-balancer connection draining), so a 2-replica rollout is
 * strictly serial: each new pod takes ~10s to become ready, +30s before it counts as available,
 * and the old pod it replaces spends 120s in preStop before the next surge can start. That is
 * ~200-320s for two replicas — MEASURED on a 3-node arm64 cluster, where the routing tier
 * reliably tripped the 120s wait while `kubectl rollout status` reported success moments later.
 * GKE dodged it only because its routing Deployment spec is often unchanged between builds.
 *
 * 600s matches the chart's `progressDeadlineSeconds`: that is Kubernetes' own verdict on a stalled
 * rollout, so waiting less rejects a rollout the cluster still considers healthy, and waiting
 * longer outlives the deadline that would mark it Failed.
 */
export const KUBECTL_ROLLOUT_TIMEOUT = "--timeout=600s";

/** Shared identifiers every gate needs — one object so the call sites stay short. */
export interface GateContext {
  releaseName: string;
  namespace: string;
  buildId: string;
  /**
   * `sanitizeK8sName(buildId)` — the EXACT version label the cutover patches Services to.
   * Computed once by the orchestrator and reused everywhere (see runCutover).
   */
  safeBuildId: string;
  previousBuildId: string | null;
  deps: CutoverDeps;
}

// 7a (D1). Wait for the new build's pool Deployments to be ready.
// Match the new build's pods/deployments by their EXACT version label — the same value the
// cutover patches Services to (`sanitizeK8sName(buildId)`, which stamps `app.kubernetes.io/
// version` on every pod). The prior match used a 12-char normalized-prefix substring, so an OLD
// build whose id shared that prefix could satisfy this readiness check; the cutover would then
// patch Services to the full new label, match zero pods, drain the NEG, and 503 the origin.
export async function waitPoolRollouts(ctx: GateContext): Promise<void> {
  const { releaseName, namespace, safeBuildId, deps } = ctx;
  console.log(`\n  → Waiting for new pods to be ready...`);
  const newDeployResult = await execCapture(
    "kubectl",
    [
      "get",
      "deployments",
      "-n",
      namespace,
      "-l",
      `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${safeBuildId}`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  // The routing service carries the same version label but is a stable in-place Deployment,
  // verified separately below — exclude it here by EXACT name (a substring match would
  // also exclude a pool deployment that merely contains "routing-service" in its name).
  const routingDeploy = routingServiceDeploymentName(releaseName);
  const newDeploys = (newDeployResult.stdout?.trim().split("\n") ?? []).filter(
    (n) => n && n !== routingDeploy,
  );

  for (const deployName of newDeploys) {
    console.log(`    Waiting for ${deployName}...`);
    const rollout = await execCapture(
      "kubectl",
      ["rollout", "status", `deployment/${deployName}`, "-n", namespace, KUBECTL_ROLLOUT_TIMEOUT],
      { timeoutMs: EXEC_TIMEOUTS.rollout },
    );
    // The pod-health gate below is the real readiness gate, but don't walk into it on
    // an already-failed rollout — the exit code was previously discarded, so a stuck
    // deployment burned the whole 2-minute health budget before failing.
    if (rollout.exitCode !== 0) {
      // N25: the edge already runs the new build (helm overwrote the stable manifest
      // ConfigMap) — put it back before claiming the previous build is still serving.
      const edge = await deps.restoreEdgeToPreviousBuild();
      throw new Error(
        [
          `Deployment ${deployName} did not finish rolling out within 120s. Traffic was ` +
            `NOT switched — the previous build's pools are still serving.`,
          // L14: kubectl rollout output carries controller/admission messages.
          `${sanitizeForTerminal((rollout.stderr || rollout.stdout).trim())}`,
          `Inspect: kubectl logs deployment/${deployName} -n ${namespace} --tail=40`,
          ...deps.edgeStatusLines(edge),
        ].join("\n"),
      );
    }
  }
}

// 7a-bis (D2). The routing service (ext_proc edge) is a stable Deployment updated in place
// per build, and was historically excluded from readiness. That let a broken image
// (e.g. a missing @next/routing) crashloop undetected for months while Kubernetes kept
// the old ReplicaSet serving stale edge code and the deploy reported success. Verify it
// actually rolls out; a stuck rollout is fatal.
export async function waitRoutingRollout(ctx: GateContext): Promise<void> {
  const { releaseName, namespace, deps } = ctx;
  const routingDeploy = routingServiceDeploymentName(releaseName);
  const rsExists = await execCapture(
    "kubectl",
    ["get", "deployment", routingDeploy, "-n", namespace, "--ignore-not-found", "-o", "name"],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (rsExists.exitCode === 0 && rsExists.stdout.trim()) {
    console.log(`    Waiting for ${routingDeploy}...`);
    const rsRollout = await execCapture(
      "kubectl",
      [
        "rollout",
        "status",
        `deployment/${routingDeploy}`,
        "-n",
        namespace,
        KUBECTL_ROLLOUT_TIMEOUT,
      ],
      { timeoutMs: EXEC_TIMEOUTS.rollout },
    );
    if (rsRollout.exitCode !== 0) {
      // The new routing pods can't roll — but the OLD routing pods already picked up the
      // new build's manifest from the (helm-overwritten) stable ConfigMap via kubelet
      // volume sync, so the edge is on the new build regardless. Revert it (N25).
      const edge = await deps.restoreEdgeToPreviousBuild();
      throw new Error(
        [
          `Routing service (${routingDeploy}) did not become healthy. Traffic was NOT ` +
            `switched — the previous build's pools are still serving.`,
          `${(rsRollout.stderr || rsRollout.stdout).trim()}`,
          `Inspect: kubectl logs -l app.kubernetes.io/component=routing-service -n ${namespace} --tail=40`,
          ...deps.edgeStatusLines(edge),
        ].join("\n"),
      );
    }
  }
}

// D3. The traffic extension is part of the middleware security boundary. Reconcile and verify
// it while the active Services still select the previous build; never cut traffic and call
// the deploy successful with a missing/incomplete ext_proc backend.
export async function waitRouteExtJob(ctx: GateContext, currentRouteExtJob: string): Promise<void> {
  const { namespace, deps } = ctx;
  const wait = await execCapture(
    "kubectl",
    [
      "wait",
      "--for=condition=complete",
      `job/${currentRouteExtJob}`,
      "-n",
      namespace,
      "--timeout=600s",
    ],
    { timeoutMs: EXEC_TIMEOUTS.rollout },
  );
  if (wait.exitCode !== 0) {
    const edge = await deps.restoreEdgeToPreviousBuild();
    throw new Error(
      [
        `ext_proc registration job (${currentRouteExtJob}) did not complete; refusing ` +
          `traffic cutover because middleware may not be wired.`,
        // L14: kubectl wait output carries controller/admission messages.
        `${sanitizeForTerminal((wait.stderr || wait.stdout).trim())}`,
        `Inspect: kubectl logs job/${currentRouteExtJob} -n ${namespace}`,
        ...deps.edgeStatusLines(edge),
      ].join("\n"),
    );
  }
  console.log("  → ext_proc traffic extension registration job completed ✓");
}

// D4-D5. The SAME boundary, for providers that register ext_proc in-cluster. There is no Job to
// wait on, so before this the generic path verified NOTHING: an EnvoyExtensionPolicy with
// Accepted=False, a GatewayClass whose controller is not Envoy, or label drift on the proxy
// selector would all leave traffic 500ing (fail-closed) or silently routed without the edge
// tier — while the deploy printed success. Middleware not running is the exact class of
// failure this gate exists for, so it must cover both registration mechanisms.
export async function waitPolicyAccepted(ctx: GateContext): Promise<void> {
  const { releaseName, namespace, deps } = ctx;
  const policyName = `${releaseName}-routing-extproc`;
  // POLL, and require the condition to be CURRENT for the object's generation.
  //
  // A single immediate read was wrong twice over: a freshly reconciled policy may have no
  // status yet (false abort), and an UPDATED policy retains the previous
  // `Accepted=True` until the controller catches up (false pass — the dangerous direction,
  // since it green-lights a cutover whose edge may not be wired). `observedGeneration`
  // vs `metadata.generation` is what distinguishes "accepted" from "accepted, previously".
  //
  // Ancestors are a map-like list, not an ordered one, so `[0]` is not necessarily this
  // release's Gateway/route — select by the Envoy Gateway controller instead.
  let status = "";
  let detail = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    const read = await execCapture(
      "kubectl",
      ["get", "envoyextensionpolicy", policyName, "-n", namespace, "-o", "json"],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    detail = (read.stderr || "").trim();
    if (read.exitCode === 0) {
      try {
        const obj = JSON.parse(read.stdout) as {
          metadata?: { generation?: number };
          status?: {
            ancestors?: Array<{
              controllerName?: string;
              conditions?: Array<{
                type?: string;
                status?: string;
                observedGeneration?: number;
              }>;
            }>;
          };
        };
        const generation = obj.metadata?.generation;
        const ancestors = obj.status?.ancestors ?? [];
        const mine =
          ancestors.find((a) => a.controllerName?.includes("gateway.envoyproxy.io")) ??
          ancestors[0];
        const cond = mine?.conditions?.find((c) => c.type === "Accepted");
        const current =
          cond !== undefined &&
          (generation === undefined ||
            cond.observedGeneration === undefined ||
            cond.observedGeneration >= generation);
        if (cond && current) {
          status = cond.status ?? "";
          if (status === "True") break;
          // A definitive False is final — waiting will not fix a rejected policy.
          if (status === "False") break;
        }
      } catch {
        // Unparseable status: keep polling rather than treating it as a verdict.
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (status !== "True") {
    const edge = await deps.restoreEdgeToPreviousBuild();
    throw new Error(
      [
        `ext_proc EnvoyExtensionPolicy (${policyName}) is not Accepted (status ` +
          `${status || "unknown"}); refusing traffic cutover because middleware would not ` +
          `run at the edge.`,
        sanitizeForTerminal(detail),
        `Inspect: kubectl describe envoyextensionpolicy ${policyName} -n ${namespace}`,
        `Common causes: the GatewayClass controller is not Envoy Gateway (an ` +
          `EnvoyExtensionPolicy only applies to one), or the Gateway it targets does not exist.`,
        ...deps.edgeStatusLines(edge),
      ].join("\n"),
    );
  }
  console.log("  → ext_proc EnvoyExtensionPolicy accepted ✓");
}

/**
 * S18 (D6 seeding), pure: capacity targets seeded from EVERY configured pool at a floor of
 * one, not only from pools with a live predecessor. previousReplicasByPool has no entry for
 * a pool that is new in this build, nor for any pool on a first deploy, so those pools used
 * to contribute no expectation at all: a sibling's ready pods satisfied `checkedCount > 0`,
 * the gate passed, and cutover then patched EVERY active Service to the new build — leaving
 * the new pool's Service with zero endpoints and serving 503s. One ready pod is the weakest
 * claim worth making ("something in this pool is actually serving"), and for pools that DO
 * have a predecessor the real count overwrites it immediately.
 */
export function computeCapacityTargets(
  pools: string[],
  previousReplicasByPool: Map<string, number>,
): Map<string, number> {
  const capacityTargets = new Map<string, number>(pools.map((poolName) => [poolName, 1]));
  for (const [poolName, replicas] of previousReplicasByPool) {
    // A removed/renamed pool has no incoming Deployment to warm. It remains in
    // previousReplicasByPool because deploy must preserve and later park it, but adding it
    // here creates an impossible health target and makes every topology-changing deploy time
    // out before cutover. Only common pools inherit outgoing capacity; newly-added pools keep
    // the one-ready-pod floor above.
    if (capacityTargets.has(poolName)) capacityTargets.set(poolName, replicas);
  }
  return capacityTargets;
}

export interface HpaWarmup {
  capacityTargets: Map<string, number>;
  /**
   * N67: put both temporary warm-up bounds back on EVERY exit path (success AND abort) —
   * the chart's own bounds are the right ones to autoscale under.
   */
  restoreWarmedHpas: () => Promise<void>;
}

// 7a-ter (D6). N64: match the outgoing build's CAPACITY before the readiness gate can pass.
// The chart renders a new build at its HPA floor (`replicas.min`), while the build
// being replaced may be sitting far above that after autoscaling under load. Cutting
// over then hands 100% of traffic to `min` pods with the HPA climbing from behind —
// and the gate cannot simply WAIT for the higher count, because with no traffic yet
// nothing would ever scale the new build up. So ask for the capacity explicitly here;
// the HPA takes over from real load once traffic arrives, and the next helm upgrade
// re-renders the floor.
//
// N67: `helm upgrade` ALSO installed the new build's own HPA
// (`<release>-<pool>-<build>-hpa`) with the chart's `replicas.min`/`replicas.max`. When
// the outgoing build sits ABOVE the new chart's `max` — it autoscaled under load, or a
// rollback widened it (N26), or the operator lowered the ceiling — the autoscaler
// reconciles the manual scale below straight back down within one control loop, and the
// gate at 7b then waits for a count that can NEVER be reached: the deploy burned the
// whole health budget and aborted BEFORE cutover, i.e. the capacity gate blocked every
// such deploy. Raising only maxReplicas is not enough: an idle new build has no load,
// so the HPA's desired count remains its configured minReplicas and it can reconcile a
// manual `kubectl scale` straight back to that floor. Do not assume a scale-down
// stabilization window protects the warm-up — that behavior is configurable and is not
// part of the generated HPA. Temporarily lift BOTH bounds around the capacity gate,
// remember their exact chart-rendered values, and put both back on EVERY exit path
// (success AND abort). After cutover, real load under the chart's own bounds decides the
// count again.
export async function warmUpHpas(
  ctx: GateContext,
  pools: string[],
  previousReplicasByPool: Map<string, number>,
): Promise<HpaWarmup> {
  const { releaseName, namespace, buildId, deps } = ctx;
  const warmedHpas: { name: string; min: number; max: number }[] = [];
  const restoredWarmedHpas = new Set<string>();
  const restoreWarmedHpas = async (): Promise<void> => {
    for (const { name, min, max } of warmedHpas) {
      if (restoredWarmedHpas.has(name)) continue;
      let lastFailure = "";
      for (let attempt = 1; attempt <= 3; attempt++) {
        const restore = await execCapture(
          "kubectl",
          [
            "patch",
            "hpa",
            name,
            "-n",
            namespace,
            "--type=merge",
            // Same field-manager rationale as the Service/Deployment patches: helm owns the
            // chart-rendered HPA, so the next `helm upgrade` must not conflict here.
            "--field-manager=helm",
            "-p",
            JSON.stringify({ spec: { minReplicas: min, maxReplicas: max } }),
          ],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (restore.exitCode === 0) {
          restoredWarmedHpas.add(name);
          console.log(`  → Restored ${name} to the chart's minReplicas=${min}, maxReplicas=${max}`);
          break;
        }
        lastFailure = sanitizeForTerminal(restore.stderr.trim()) || `exit ${restore.exitCode}`;
      }
      if (!restoredWarmedHpas.has(name)) {
        console.warn(
          `  ! Could not restore ${name} to the chart's minReplicas=${min}, ` +
            `maxReplicas=${max} after 3 attempts (${lastFailure}) — ` +
            `it still has the temporary pre-cutover bounds, so this pool may retain warm-up ` +
            `capacity until the next \`helm upgrade\` re-renders it. Fix it with: kubectl -n ` +
            `${namespace} patch hpa ${name} --type=merge -p ` +
            `'{"spec":{"minReplicas":${min},"maxReplicas":${max}}}'`,
        );
      }
    }
  };

  // A partial warm-up setup cannot safely continue. If the HPA cannot be read, its
  // original bounds cannot be restored; if the temporary patch is rejected, it may
  // immediately lower the idle Deployment again. Restore every pool already prepared and
  // put ext_proc back on the serving build before failing, without waiting out the health
  // budget for a capacity target that is not stable.
  const abortWarmupSetup = async (message: string): Promise<never> => {
    const edge = await deps.restoreEdgeToPreviousBuild();
    await restoreWarmedHpas();
    throw new Error([message, ...deps.edgeStatusLines(edge)].join("\n"));
  };

  const capacityTargets = computeCapacityTargets(pools, previousReplicasByPool);

  const shortfalls: string[] = [];
  for (const poolName of pools) {
    const outgoing = previousReplicasByPool.get(poolName);
    const { hpa: newHpaName } = poolResourceNames(releaseName, poolName, buildId);

    // The chart always renders one HPA per pool. A missing HPA after Helm means the release
    // was only partially applied; accepting it would cut traffic to an unautoscaled pool.
    // Probe every pool, including first-deploy and newly added pools, before scaling any of
    // them. `--ignore-not-found` keeps absence machine-readable without hiding read errors.
    const hpaRead = await execCapture(
      "kubectl",
      [
        "get",
        "hpa",
        newHpaName,
        "-n",
        namespace,
        "--ignore-not-found",
        "-o",
        "jsonpath={.metadata.name}|{.spec.minReplicas}|{.spec.maxReplicas}",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (hpaRead.exitCode !== 0) {
      await abortWarmupSetup(
        `Could not read the new build's HPA ${newHpaName} (kubectl exited ` +
          `${hpaRead.exitCode}${hpaRead.stderr.trim() ? `: ${sanitizeForTerminal(hpaRead.stderr.trim())}` : ""}). ` +
          `Refusing to warm pool "${poolName}" because its original bounds cannot be ` +
          `preserved or its capacity kept stable. Nothing was cut over.`,
      );
    }

    const [hpaFound, hpaMinField, hpaMaxField] = hpaRead.stdout.trim().split("|");
    if (!hpaFound) {
      await abortWarmupSetup(
        `The new build's expected HPA ${newHpaName} was not found after Helm applied the ` +
          `release. Refusing to cut over pool "${poolName}" to a partially applied build. ` +
          `Nothing was cut over.`,
      );
    }
    const hpaMin = Number(hpaMinField);
    const hpaMax = Number(hpaMaxField);
    if (!Number.isInteger(hpaMin) || hpaMin < 1 || !Number.isInteger(hpaMax) || hpaMax < hpaMin) {
      await abortWarmupSetup(
        `Could not parse the new build's HPA ${newHpaName} bounds ` +
          `(minReplicas=${JSON.stringify(hpaMinField ?? "")}, ` +
          `maxReplicas=${JSON.stringify(hpaMaxField ?? "")}). Refusing to warm pool ` +
          `"${poolName}" because its original bounds cannot be restored safely. ` +
          `Nothing was cut over.`,
      );
    }

    if (outgoing !== undefined && hpaMin < outgoing) {
      const warmMin = outgoing;
      const warmMax = Math.max(hpaMax, warmMin);
      console.log(
        `  → Warming ${newHpaName} at minReplicas=${warmMin}, ` +
          `maxReplicas=${warmMax} so the idle new pool keeps the outgoing build's ` +
          `${outgoing} replicas (restored to minReplicas=${hpaMin}, ` +
          `maxReplicas=${hpaMax} after cutover)`,
      );
      const warm = await execCapture(
        "kubectl",
        [
          "patch",
          "hpa",
          newHpaName,
          "-n",
          namespace,
          "--type=merge",
          "--field-manager=helm",
          "-p",
          JSON.stringify({ spec: { minReplicas: warmMin, maxReplicas: warmMax } }),
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (warm.exitCode !== 0) {
        await abortWarmupSetup(
          `Could not set temporary warm-up bounds on ${newHpaName} ` +
            `(minReplicas=${warmMin}, maxReplicas=${warmMax}; ` +
            `${sanitizeForTerminal(warm.stderr.trim()) || `kubectl exited ${warm.exitCode}`}). Refusing to ` +
            `scale or cut over pool "${poolName}" because its HPA could immediately ` +
            `remove the required capacity. Nothing was cut over.`,
        );
      }
      warmedHpas.push({ name: newHpaName, min: hpaMin, max: hpaMax });
    }
  }

  // Prepare every autoscaler before scaling any Deployment. A read or admission failure
  // on a later pool then restores the earlier HPA patches without leaving part of the new
  // build manually scaled above its chart state.
  for (const [poolName, outgoing] of previousReplicasByPool) {
    const { deployment: newDeployName } = poolResourceNames(releaseName, poolName, buildId);
    const expected = capacityTargets.get(poolName) ?? outgoing;
    const cur = await execCapture(
      "kubectl",
      [
        "get",
        "deployment",
        newDeployName,
        "-n",
        namespace,
        "--ignore-not-found",
        "-o",
        "jsonpath={.metadata.name}|{.spec.replicas}",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    const [foundName, replicasField] = cur.stdout.trim().split("|");
    const current = parseInt(replicasField ?? "", 10);
    if (cur.exitCode !== 0 || !foundName || !Number.isFinite(current)) {
      // Don't abort here — the readiness gate below is the authority and will fail
      // closed if the capacity never materializes. Say why we could not pre-scale.
      console.warn(
        `  ! Could not read the new build's replica count for ${newDeployName} ` +
          `(kubectl exited ${cur.exitCode}${cur.stderr.trim() ? `: ${sanitizeForTerminal(cur.stderr.trim())}` : ""}) ` +
          `— skipping the pre-cutover scale-up to the outgoing build's ${expected} replicas.`,
      );
      continue;
    }
    if (current >= expected) continue;
    console.log(
      `  → Matching outgoing capacity for pool "${poolName}": scaling ${newDeployName} ` +
        `${current} → ${expected} replicas before cutover`,
    );
    const scaleUp = await execCapture(
      "kubectl",
      ["scale", `deployment/${newDeployName}`, "-n", namespace, `--replicas=${expected}`],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (scaleUp.exitCode !== 0) {
      shortfalls.push(
        `${newDeployName}: could not scale to ${expected} ` +
          `(${sanitizeForTerminal(scaleUp.stderr.trim()) || `exit ${scaleUp.exitCode}`})`,
      );
    }
  }
  if (shortfalls.length > 0) {
    // Not fatal on its own: the gate below requires readyReplicas >= the outgoing count
    // per pool, so an unfulfilled scale-up aborts the cutover there with full context.
    for (const s of shortfalls) console.warn(`  ! ${s}`);
  }

  return { capacityTargets, restoreWarmedHpas };
}

// 7b (D7). Wait for the new build's pods to be READY from inside the cluster.
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
export async function waitReadyCapacity(
  ctx: GateContext,
  capacityTargets: Map<string, number>,
  restoreWarmedHpas: () => Promise<void>,
): Promise<void> {
  const { releaseName, namespace, safeBuildId, deps } = ctx;
  console.log(`  → Verifying new pods are serving...`);
  let newBuildHealthy = false;
  let lastShortfall = "";
  const maxHealthAttempts = 24; // 2 minutes (5s intervals)
  for (let attempt = 0; attempt < maxHealthAttempts; attempt++) {
    let allHealthy = true;
    let checkedCount = 0;
    const readyByPool = new Map<string, number>();
    const podsResult = await execCapture(
      "kubectl",
      [
        "get",
        "pods",
        "-n",
        namespace,
        "-l",
        // The routing service shares the version label; exclude it by its component label
        // (exact — a name substring match would also drop pool pods named similarly).
        `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${safeBuildId},app.kubernetes.io/component!=routing-service`,
        "-o",
        // The component label IS the pool name (deployment.ts stamps it), which is what
        // makes the per-pool count below exact without parsing pod names.
        'jsonpath={range .items[*]}{.metadata.name}|{.status.conditions[?(@.type=="Ready")].status}|{.metadata.labels.app\\.kubernetes\\.io/component}{"\\n"}{end}',
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
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
    // Per-pool capacity check against the build being replaced.
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
    const edge = await deps.restoreEdgeToPreviousBuild();
    // N67: and both temporary warm-up bounds go back before we leave — this build is
    // being abandoned, so it must not keep the raised replica floor.
    await restoreWarmedHpas();
    console.error(`\n  DEPLOY FAILED: New build did not become healthy within 2 minutes.`);
    console.error(
      `  The previous build's pools are still serving traffic. No pool cutover was performed.`,
    );
    for (const line of deps.edgeStatusLines(edge)) console.error(line);
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
    const newPods = await execCapture(
      "kubectl",
      [
        "get",
        "pods",
        "-n",
        namespace,
        "-l",
        `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${safeBuildId},app.kubernetes.io/component!=routing-service`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}|{.status.phase}{"\\n"}{end}',
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
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
        const readyzResult = await execCapture(
          "kubectl",
          [
            "exec",
            podName,
            "-n",
            namespace,
            "--",
            "node",
            "-e",
            `const http=require("http");http.get("http://localhost:3000${POOL_READINESS_PATH}",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>console.log(r.statusCode,d))}).on("error",e=>console.log("ERR",e.message))`,
          ],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
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
        const logsResult = await execCapture(
          "kubectl",
          ["logs", podName, "-n", namespace, "--tail=20"],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
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
    throw new CutoverExitError(1);
  }
}

// Rollback's pre-flip serving gate (runRollback step 3). Prove the previous build is
// actually SERVING before cutting traffic. This replaces a dead "wait for LB health" loop
// that filtered GCP backend services by build id — pool backends are Gateway-managed and
// build-agnostic, so the filter never matched and the loop broke on its first iteration.
// What we can check truthfully: the pods we are about to cut to answer /healthz from inside
// the cluster (the same probe deploy's diagnostics use). Bounded at ~2 minutes, and an
// exhausted budget aborts BEFORE any selector patch — the current build keeps serving and
// state is untouched. GCP's NEG health checks gate the endpoints independently and
// asynchronously after the selector flip.
export async function waitPreviousBuildServing(opts: {
  releaseName: string;
  namespace: string;
  previousBuildId: string;
  safePreviousBuild: string;
  previousDeploys: { name: string }[];
}): Promise<void> {
  const { releaseName, namespace, previousBuildId, safePreviousBuild, previousDeploys } = opts;
  console.log(`  → Verifying previous build pods are serving...`);
  const HEALTHZ_SNIPPET =
    'const http=require("http");http.get("http://localhost:3000/healthz",r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))';
  let serving = false;
  const maxServeAttempts = 24; // ~2 minutes at 5s intervals
  for (let attempt = 0; attempt < maxServeAttempts && !serving; attempt++) {
    const podsResult = await execCapture(
      "kubectl",
      [
        "get",
        "pods",
        "-n",
        namespace,
        "-l",
        `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${safePreviousBuild},app.kubernetes.io/component!=routing-service`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    const pods =
      podsResult.exitCode === 0 ? podsResult.stdout.trim().split("\n").filter(Boolean) : [];
    let allServing = pods.length > 0;
    for (const previousDeploy of previousDeploys) {
      if (!allServing) break;
      // Pod names are <deployment>-<replicaset-hash>-<rand>; the trailing "-" in the
      // prefix keeps this exact (a build id suffix can never contain "-<hash>" ambiguity
      // because the deployment name itself is fixed).
      const depPods = pods.filter((p) => p.startsWith(`${previousDeploy.name}-`));
      let depServing = false;
      for (const pod of depPods) {
        const healthz = await execCapture(
          "kubectl",
          ["exec", pod, "-n", namespace, "--", "node", "-e", HEALTHZ_SNIPPET],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (healthz.exitCode === 0) {
          depServing = true;
          break;
        }
      }
      if (!depServing) allServing = false;
    }
    if (allServing) {
      serving = true;
      console.log(`    Previous build is serving ✓`);
    } else if (attempt < maxServeAttempts - 1) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!serving) {
    throw new Error(
      `Previous build ${previousBuildId} did not pass /healthz within 2 minutes. Traffic ` +
        `was NOT switched — the current build is still serving. Both builds were left scaled ` +
        `up; investigate (kubectl logs -n ${namespace} -l ` +
        `app.kubernetes.io/version=${safePreviousBuild}) and ` +
        `re-run the rollback.`,
    );
  }
}
