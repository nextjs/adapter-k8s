// src/cli/rollback.ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execCapture, execCaptureStdin, execOrThrow } from "./exec.js";
import { readState, writeState } from "./state.js";
import { invalidateCdnBuildTag } from "./cdn-invalidate.js";
import {
  assertSafeBuildId,
  assertSafeImageRegistry,
  poolResourceNames,
  sanitizeK8sName,
  // init binds Workload Identity to [default/<release>-deploy-sa]; the release lives
  // in the literal "default" namespace. Pin it on every kubectl call instead of
  // trusting whatever namespace the operator's context happens to have.
  K8S_NAMESPACE,
} from "../emit/templates/utils.js";
import {
  ROUTING_MANIFEST_VOLUME_NAME,
  routingManifestSnapshotName,
  routingServiceDeploymentName,
} from "../emit/templates/routing-manifest-configmap.js";

// Annotation stamping the FULL build id onto retained snapshot ConfigMaps. Snapshot
// NAMES go through sanitizeK8sName (lowercase + 63-char truncation), so two different
// build ids can collide on the snapshot name; the annotation is what lets retention
// detect that and refuse to clobber a different build's manifest (deploy also guards
// the composed names up front — this is defense in depth at the point of overwrite).
export const SNAPSHOT_BUILD_ID_ANNOTATION = "adapter-k8s/build-id";

interface RoutingServingConfig {
  /** Image tag the routing Deployment currently runs — the build id the edge serves. */
  imageTag: string;
  /** ConfigMap the routing-manifest volume currently mounts. */
  manifestConfigMap: string;
}

// Read what the routing tier is ACTUALLY serving (image tag + manifest source). Returns
// null when the release has no routing tier (apps without middleware/extension chain) or
// the Deployment is unreadable — callers treat null as "nothing to retain/revert".
async function readRoutingServingConfig(releaseName: string): Promise<RoutingServingConfig | null> {
  const deployName = routingServiceDeploymentName(releaseName);
  const res = await execCapture("kubectl", [
    "get",
    "deployment",
    deployName,
    "-n",
    K8S_NAMESPACE,
    "-o",
    "json",
  ]);
  if (res.exitCode !== 0 || !res.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(res.stdout);
    const podSpec = parsed?.spec?.template?.spec;
    const containers: unknown[] = Array.isArray(podSpec?.containers) ? podSpec.containers : [];
    const volumes: unknown[] = Array.isArray(podSpec?.volumes) ? podSpec.volumes : [];
    const image = (containers as { name?: string; image?: string }[]).find(
      (c) => c?.name === "routing-service",
    )?.image;
    const cmName = (volumes as { name?: string; configMap?: { name?: string } }[]).find(
      (v) => v?.name === ROUTING_MANIFEST_VOLUME_NAME,
    )?.configMap?.name;
    if (typeof image !== "string" || typeof cmName !== "string" || !cmName) return null;
    // Image form: <registry>/routing-service:<buildId> — the tag after the LAST colon.
    const tag = image.includes(":") ? image.slice(image.lastIndexOf(":") + 1) : "";
    if (!tag) return null;
    return { imageTag: tag, manifestConfigMap: cmName };
  } catch {
    return null;
  }
}

// Snapshot the manifest the routing tier currently serves into a build-named ConfigMap,
// so a later rollback can revert the edge to exactly this build's manifest. The stable
// `<release>-routing-manifest` ConfigMap is overwritten by every helm upgrade, and a
// rollback re-points the Deployment's volume at a snapshot — without this retention the
// previous build's manifest is unrecoverable and rollback can only revert the image.
// Best-effort: returns the snapshot name, or null (with a loud log) when it could not be
// written. Also used by deploy (pre-helm-upgrade) to retain the outgoing build.
export async function retainLiveRoutingManifest(
  releaseName: string,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<string | null> {
  const serving = await readRoutingServingConfig(releaseName);
  if (!serving) return null; // no routing tier on this release
  const snapshotName = routingManifestSnapshotName(releaseName, serving.imageTag);
  // Already serving from this build's snapshot (post-rollback state) — nothing to copy.
  if (serving.manifestConfigMap === snapshotName) return snapshotName;
  // Overwrite protection: if a ConfigMap already exists under this snapshot name but is
  // stamped with a DIFFERENT build id, the two builds' snapshot names collide after
  // sanitization — overwriting would destroy that build's only retained manifest.
  // Abort loudly instead of silently clobbering it. Unstamped snapshots (written by
  // pre-annotation versions of this CLI) are overwritten as before, and a failed read
  // stays best-effort (the apply below surfaces real cluster trouble).
  const existing = await execCapture("kubectl", [
    "get",
    "configmap",
    snapshotName,
    "-n",
    K8S_NAMESPACE,
    "--ignore-not-found",
    "-o",
    "json",
  ]);
  if (existing.exitCode === 0 && existing.stdout.trim()) {
    let storedBuildId: unknown;
    try {
      storedBuildId = JSON.parse(existing.stdout)?.metadata?.annotations?.[
        SNAPSHOT_BUILD_ID_ANNOTATION
      ];
    } catch {
      storedBuildId = undefined; // unparseable — treat as unstamped
    }
    if (typeof storedBuildId === "string" && storedBuildId && storedBuildId !== serving.imageTag) {
      throw new Error(
        `Refusing to overwrite routing-manifest snapshot ConfigMap ${snapshotName}: it holds ` +
          `the retained manifest for build "${storedBuildId}", but the routing tier is ` +
          `serving build "${serving.imageTag}" — the two build ids collide on the snapshot ` +
          `name after Kubernetes name sanitization. Overwriting would destroy build ` +
          `"${storedBuildId}"'s only retained manifest. Choose build ids that still differ ` +
          `inside the 63-char resource-name limit.`,
      );
    }
  }
  const cm = await execCapture("kubectl", [
    "get",
    "configmap",
    serving.manifestConfigMap,
    "-n",
    K8S_NAMESPACE,
    "-o",
    "json",
  ]);
  let data: unknown;
  if (cm.exitCode === 0 && cm.stdout.trim()) {
    try {
      data = JSON.parse(cm.stdout)?.data;
    } catch {
      data = undefined;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    log(
      `  ! Could not retain the routing manifest for build ${serving.imageTag} ` +
        `(ConfigMap ${serving.manifestConfigMap} unreadable) — a rollback to this build ` +
        `would revert the edge image only.`,
    );
    return null;
  }
  const snapshot = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: snapshotName,
      labels: {
        "app.kubernetes.io/name": releaseName,
        // kubectl-created (not helm-owned) — destroy deletes by this label pair.
        "app.kubernetes.io/managed-by": "adapter-k8s",
        "app.kubernetes.io/component": "routing-manifest-snapshot",
      },
      // An ANNOTATION, not a label: build ids may exceed the 63-char label-value limit.
      annotations: {
        [SNAPSHOT_BUILD_ID_ANNOTATION]: serving.imageTag,
      },
    },
    data,
  };
  // Via stdin: the manifest can approach the ~1 MiB ConfigMap limit, far over a safe
  // argv length, and secrets never go on argv.
  const applied = await execCaptureStdin(
    "kubectl",
    ["apply", "-n", K8S_NAMESPACE, "-f", "-"],
    JSON.stringify(snapshot),
  );
  if (applied.exitCode !== 0) {
    log(
      `  ! Could not retain the routing manifest for build ${serving.imageTag}: ` +
        `${applied.stderr.trim() || `exit ${applied.exitCode}`} — a rollback to this ` +
        `build would revert the edge image only.`,
    );
    return null;
  }
  log(`  → Retained routing manifest for build ${serving.imageTag} → ${snapshotName}`);
  return snapshotName;
}

// Revert the routing tier (image AND manifest) to `targetBuildId` and wait for the
// rollout. The routing Deployment is updated in place to `routing-service:<buildId>` on
// every deploy while the stable manifest ConfigMap is overwritten, so a pool-only
// rollback leaves the edge running the rolled-away-from build's middleware and manifest.
// Ordering mirrors deploy: the edge is reverted BEFORE the pool Service selectors flip.
//
// If the retained manifest snapshot for the target build is missing (only possible for
// builds last deployed before manifest retention existed), degrade to an image-only
// revert with a loud warning instead of stranding the whole rollback: a manifest skew
// is absorbed by the pools' fail-safe local re-resolution (invariant 1), whereas a
// broken deploy that cannot be rolled back at all is an outage.
async function revertRoutingServiceToBuild(opts: {
  releaseName: string;
  targetBuildId: string;
  registry: string | undefined;
}): Promise<void> {
  const { releaseName, targetBuildId, registry } = opts;
  const deployName = routingServiceDeploymentName(releaseName);
  const exists = await execCapture("kubectl", [
    "get",
    "deployment",
    deployName,
    "-n",
    K8S_NAMESPACE,
    "--ignore-not-found",
    "-o",
    "name",
  ]);
  if (exists.exitCode !== 0 || !exists.stdout.trim()) return; // no routing tier

  if (!registry) {
    throw new Error(
      `infrastructure.json is missing containerRegistry, so the routing service image ` +
        `reference cannot be formed. Restore it (re-run \`npx adapter-k8s init\`) and ` +
        `re-run the rollback. Traffic was NOT switched.`,
    );
  }

  // Retain the manifest we are about to roll AWAY from, so the symmetric roll-forward
  // can restore it (its stable-ConfigMap content is otherwise lost on the next deploy).
  await retainLiveRoutingManifest(releaseName);

  const targetSnapshot = routingManifestSnapshotName(releaseName, targetBuildId);
  const snap = await execCapture("kubectl", [
    "get",
    "configmap",
    targetSnapshot,
    "-n",
    K8S_NAMESPACE,
    "--ignore-not-found",
    "-o",
    "name",
  ]);
  const haveSnapshot = snap.exitCode === 0 && !!snap.stdout.trim();
  if (!haveSnapshot) {
    console.warn(
      `  ! No retained routing manifest for build ${targetBuildId} (${targetSnapshot} not ` +
        `found). Reverting the routing IMAGE only — the edge keeps the current manifest and ` +
        `mismatched routes fall back to pool-local re-resolution. Future deploys retain the ` +
        `manifest automatically.`,
    );
  }

  const image = `${registry}/routing-service:${targetBuildId}`;
  const patch = {
    spec: {
      template: {
        spec: {
          containers: [{ name: "routing-service", image }],
          ...(haveSnapshot
            ? {
                volumes: [
                  {
                    name: ROUTING_MANIFEST_VOLUME_NAME,
                    configMap: { name: targetSnapshot },
                  },
                ],
              }
            : {}),
        },
      },
    },
  };
  console.log(
    `  → Reverting routing service to build ${targetBuildId}${haveSnapshot ? "" : " (image only)"}...`,
  );
  const patched = await execCapture("kubectl", [
    "patch",
    "deployment",
    deployName,
    "-n",
    K8S_NAMESPACE,
    "--type=strategic",
    // Same field-manager rationale as the Service selector patches below: helm owns this
    // Deployment, so the next `helm upgrade` must not conflict on the fields we flip here.
    "--field-manager=helm",
    "-p",
    JSON.stringify(patch),
  ]);
  if (patched.exitCode !== 0) {
    throw new Error(
      `Failed to revert the routing service (${deployName}): ` +
        `${patched.stderr.trim() || `exit ${patched.exitCode}`}. Traffic was NOT switched; ` +
        `the pools and the edge are still on the current build.`,
    );
  }
  // A stuck routing rollout is fatal (same posture as deploy's 7a-bis): with
  // maxUnavailable 0 the old ReplicaSet keeps serving, but reporting success while the
  // edge cannot roll would repeat the historical crashloop-for-months incident.
  await execOrThrow("kubectl", [
    "rollout",
    "status",
    `deployment/${deployName}`,
    "-n",
    K8S_NAMESPACE,
    "--timeout=120s",
  ]);
}

export async function runRollback(options: {
  projectDir: string;
  releaseName: string;
  dryRun?: boolean;
}): Promise<void> {
  const { projectDir, releaseName, dryRun } = options;

  const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
  const infra = existsSync(infraPath) ? JSON.parse(readFileSync(infraPath, "utf-8")) : undefined;

  // Pin kubectl at THIS release's cluster BEFORE any cluster read — the state ConfigMap
  // read below previously ran against whatever context happened to be current, so a
  // rollback could read (and then act on) another cluster's build state. Dry-run must
  // not mutate the operator's kubeconfig (L13), so it skips this and reads local
  // state only.
  if (!dryRun && infra?.projectId && infra?.region) {
    const credResult = await execCapture("gcloud", [
      "container",
      "clusters",
      "get-credentials",
      `${releaseName}-cluster`,
      "--region",
      infra.region,
      "--project",
      infra.projectId,
      "--quiet",
    ]);
    if (credResult.exitCode !== 0) {
      throw new Error(`Failed to connect to cluster: ${credResult.stderr.trim()}`);
    }
  }

  const state = await readState(projectDir, releaseName, dryRun ? { localOnly: true } : undefined);
  if (!state?.previousBuildId) {
    // Dry-run deliberately reads the LOCAL state file only (L13 — no cluster access),
    // so "no previous build" may just mean the local file is missing/stale while the
    // cluster's deploy-state ConfigMap records more history. Say so instead of the
    // misleading "only one deploy has been recorded".
    throw new Error(
      dryRun
        ? "No previous build to roll back to in the LOCAL state file. Dry-run deliberately " +
            "reads local state only (no cluster access) — the cluster's deploy-state " +
            "ConfigMap may record more history. Run without --dry-run to consult it."
        : "No previous build to roll back to. Only one deploy has been recorded.",
    );
  }

  const { buildId: currentBuildId, previousBuildId } = state;

  // Pool names come from local build metadata (the same source deploy's cutover uses) —
  // readable without touching the cluster, so the dry-run plan can be printed before any
  // cluster interaction.
  let poolNames: string[] = [];
  const metaPath = path.join(projectDir, ".k8s-adapter", "output", "build-metadata.json");
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      if (Array.isArray(meta.pools)) {
        poolNames = meta.pools.filter((p: unknown): p is string => typeof p === "string");
      }
    } catch {
      // fall through to the empty guard
    }
  }

  // L13: dry-run must not mutate anything — and get-credentials mutates the operator's
  // kubeconfig, so it is skipped too. Print the planned steps and return.
  if (dryRun) {
    const prevNames = poolNames.map((p) =>
      sanitizeK8sName(`${releaseName}-${p}-${previousBuildId}`),
    );
    const currNames = poolNames.map((p) =>
      sanitizeK8sName(`${releaseName}-${p}-${currentBuildId}`),
    );
    console.log(`\n  [dry-run] Rollback plan: ${currentBuildId} → ${previousBuildId}`);
    console.log(
      `  [dry-run] Skipping "gcloud container clusters get-credentials" (it would mutate your kubeconfig).`,
    );
    console.log(`  [dry-run] Reading deploy state from the LOCAL file only (no cluster access).`);
    if (prevNames.length > 0)
      console.log(`  [dry-run] Would scale up previous build: ${prevNames.join(", ")}`);
    console.log(`  [dry-run] Would wait for the previous build's rollout to complete`);
    console.log(`  [dry-run] Would verify the previous build's pods are serving /healthz`);
    console.log(
      `  [dry-run] Would revert the routing service to image routing-service:${previousBuildId} ` +
        `and manifest ConfigMap ${routingManifestSnapshotName(releaseName, previousBuildId)}`,
    );
    console.log(
      `  [dry-run] Would patch active Service selectors to app.kubernetes.io/version=${sanitizeK8sName(previousBuildId)}`,
    );
    if (currNames.length > 0)
      console.log(`  [dry-run] Would scale down current build: ${currNames.join(", ")}`);
    console.log(
      `  [dry-run] Would swap state: buildId=${previousBuildId}, previousBuildId=${currentBuildId}`,
    );
    return;
  }

  if (poolNames.length === 0) {
    throw new Error(
      "Could not determine pool names from .k8s-adapter/output/build-metadata.json; " +
        "cannot safely roll back. Aborting before touching traffic.",
    );
  }

  console.log(`\nRolling back: ${currentBuildId} → ${previousBuildId}\n`);

  // Find the previous deployment
  const deploysResult = await execCapture("kubectl", [
    "get",
    "deployments",
    "-n",
    K8S_NAMESPACE,
    "-l",
    `app.kubernetes.io/name=${releaseName}`,
    "-o",
    'jsonpath={range .items[*]}{.metadata.name}|{.status.replicas}{"\\n"}{end}',
  ]);

  if (deploysResult.exitCode !== 0) {
    throw new Error("Failed to list deployments. Is kubectl connected?");
  }

  // Roll back EVERY pool, not just one. Single previous/current vars kept only the LAST
  // pool that matched during discovery, so a multi-pool rollback scaled up one pool's
  // previous Deployment but then switched ALL active Services to the previous build —
  // every other pool was left at zero replicas with no endpoints. The pool list was read
  // from build metadata above (the same source deploy's cutover uses); resolve each
  // pool's previous and current Deployment by exact name, and verify every previous pool
  // exists BEFORE touching traffic.
  const scalingByPool = new Map<string, { min: number; max: number; targetCPU: number }>();
  const valuesPath = path.join(projectDir, ".k8s-adapter", "output", "chart", "values.yaml");
  if (existsSync(valuesPath)) {
    try {
      const raw = readFileSync(valuesPath, "utf-8");
      const values = JSON.parse(raw.slice(raw.indexOf("{")));
      for (const pool of poolNames) {
        const replicas = values.pools?.[pool]?.replicas;
        if (replicas) scalingByPool.set(pool, replicas);
      }
    } catch {
      // Defaults below match renderValuesYaml.
    }
  }

  const discovered = new Set(
    deploysResult.stdout
      .trim()
      .split("\n")
      .map((l) => l.split("|")[0])
      .filter(Boolean),
  );
  // Carry the pool and the template-derived HPA name alongside each Deployment name:
  // the HPA truncates its base at 59 chars (suffix reserved INSIDE the 63-char cap,
  // hpa.ts), so it must come from poolResourceNames — appending "-hpa" to the
  // 63-truncated deployment name diverges past that boundary (and can exceed 63
  // chars), making rollback miss the retained HPA and `kubectl autoscale` fail on an
  // invalid name.
  interface PoolDeploy {
    pool: string;
    name: string;
    hpa: string;
  }
  const previousDeploys: PoolDeploy[] = [];
  const currentDeploys: PoolDeploy[] = [];
  const missingPrev: string[] = [];
  for (const pool of poolNames) {
    const prev = poolResourceNames(releaseName, pool, previousBuildId);
    const curr = poolResourceNames(releaseName, pool, currentBuildId);
    if (discovered.has(prev.deployment)) {
      previousDeploys.push({ pool, name: prev.deployment, hpa: prev.hpa });
    } else missingPrev.push(pool);
    if (discovered.has(curr.deployment)) {
      currentDeploys.push({ pool, name: curr.deployment, hpa: curr.hpa });
    }
  }

  if (missingPrev.length > 0) {
    throw new Error(
      `Previous deployment missing for pool(s): ${missingPrev.join(", ")} (build ` +
        `${previousBuildId}). Rolling back would strand those pools with zero endpoints. ` +
        `Aborting. Only one previous build is retained after each deploy.`,
    );
  }

  // 1. Scale up every pool's previous deployment
  for (const previousDeploy of previousDeploys) {
    console.log(`  → Scaling up previous build: ${previousDeploy.name}`);
    await execOrThrow("kubectl", [
      "scale",
      `deployment/${previousDeploy.name}`,
      "-n",
      K8S_NAMESPACE,
      "--replicas=2",
    ]);
  }

  // Recreate the rollback build's HPA. Deploy removes it before parking that build at zero,
  // otherwise the autoscaler would immediately raise it back to minReplicas. The name comes
  // from poolResourceNames so the existence probe finds the HPA the template actually
  // rendered (see the divergence note at the discovery loop above).
  for (const previousDeploy of previousDeploys) {
    const hpaName = previousDeploy.hpa;
    const hpa = await execCapture("kubectl", [
      "get",
      "hpa",
      hpaName,
      "-n",
      K8S_NAMESPACE,
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    if (!hpa.stdout.trim()) {
      const scaling = scalingByPool.get(previousDeploy.pool) ?? { min: 1, max: 3, targetCPU: 80 };
      await execOrThrow("kubectl", [
        "autoscale",
        "deployment",
        previousDeploy.name,
        "-n",
        K8S_NAMESPACE,
        `--name=${hpaName}`,
        `--min=${scaling.min}`,
        `--max=${scaling.max}`,
        `--cpu=${scaling.targetCPU}%`,
      ]);
    }
  }

  // 2. Wait for every previous pool's pods to be ready
  console.log(`  → Waiting for previous build pods to be ready...`);
  for (const previousDeploy of previousDeploys) {
    await execOrThrow("kubectl", [
      "rollout",
      "status",
      `deployment/${previousDeploy.name}`,
      "-n",
      K8S_NAMESPACE,
      "--timeout=120s",
    ]);
  }

  // 3. Prove the previous build is actually SERVING before cutting traffic. This replaces
  // a dead "wait for LB health" loop that filtered GCP backend services by build id — pool
  // backends are Gateway-managed and build-agnostic, so the filter never matched and the
  // loop broke on its first iteration. What we can check truthfully: the pods we are about
  // to cut to answer /healthz from inside the cluster (the same probe deploy's diagnostics
  // use). Bounded at ~2 minutes, and an exhausted budget aborts BEFORE any selector patch —
  // the current build keeps serving and state is untouched. GCP's NEG health checks gate
  // the endpoints independently and asynchronously after the selector flip.
  const safePreviousBuild = sanitizeK8sName(previousBuildId);
  console.log(`  → Verifying previous build pods are serving...`);
  const HEALTHZ_SNIPPET =
    'const http=require("http");http.get("http://localhost:3000/healthz",r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))';
  let serving = false;
  const maxServeAttempts = 24; // ~2 minutes at 5s intervals
  for (let attempt = 0; attempt < maxServeAttempts && !serving; attempt++) {
    const podsResult = await execCapture("kubectl", [
      "get",
      "pods",
      "-n",
      K8S_NAMESPACE,
      "-l",
      `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${safePreviousBuild},app.kubernetes.io/component!=routing-service`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ]);
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
        const healthz = await execCapture("kubectl", [
          "exec",
          pod,
          "-n",
          K8S_NAMESPACE,
          "--",
          "node",
          "-e",
          HEALTHZ_SNIPPET,
        ]);
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
        `up; investigate (kubectl logs -l app.kubernetes.io/version=${safePreviousBuild}) and ` +
        `re-run the rollback.`,
    );
  }

  // 3b. Revert the routing tier (image + manifest) to the previous build BEFORE flipping
  // pool traffic — the same order deploy applies (edge first, selectors second), so the
  // middleware/manifest never trails the pools by more than one step.
  assertSafeBuildId(previousBuildId);
  if (infra?.containerRegistry) assertSafeImageRegistry(infra.containerRegistry);
  await revertRoutingServiceToBuild({
    releaseName,
    targetBuildId: previousBuildId,
    registry: infra?.containerRegistry,
  });

  // 4. Switch traffic: patch active Service selectors to the previous build.
  // The selector value MUST use the same sanitizer that stamped the pod label
  // (sanitizeK8sName prepends `b-` when the build id starts with a non-letter). A
  // divergent value (the old inline sanitizer omitted the `b-` prefix) matches no pods,
  // draining the active Service to zero endpoints and 503'ing the site on rollback.
  // (safePreviousBuild is computed once in step 3 above and reused here.)

  // Switch each active Service (`<release>-<pool>`) by NAME, exactly as deploy's cutover
  // does — reusing the pool list resolved above. (The active-service template's
  // `managed-by: adapter-k8s-active` label is overwritten by Helm to `managed-by: Helm`,
  // so a label selector would match nothing, patch ZERO Services, skip the failure guard,
  // and strand the site when the current build is scaled down.)
  const patchFailures: { service: string; stderr: string }[] = [];
  const patchedServices: string[] = [];
  console.log(`  → Switching traffic to previous build...`);
  for (const pool of poolNames) {
    const svcName = sanitizeK8sName(`${releaseName}-${pool}`);
    const patchResult = await execCapture("kubectl", [
      "patch",
      "service",
      svcName,
      "-n",
      K8S_NAMESPACE,
      "--type=json",
      // --force-conflicts is NOT a valid `kubectl patch` flag (only `apply
      // --server-side` accepts it); a JSON patch needs no conflict override.
      "--field-manager=helm",
      "-p",
      JSON.stringify([
        {
          op: "replace",
          path: "/spec/selector/app.kubernetes.io~1version",
          value: safePreviousBuild,
        },
      ]),
    ]);
    if (patchResult.exitCode !== 0) {
      patchFailures.push({ service: svcName, stderr: patchResult.stderr.trim() });
    } else {
      patchedServices.push(svcName);
    }
  }

  // If any selector patch failed, traffic did not switch to the previous build.
  // Scaling the current deployment to 0 now would strand the still-current Services
  // with zero endpoints. Abort before scale-down, leaving the current build serving.
  if (patchFailures.length > 0) {
    const safeCurrentBuild = sanitizeK8sName(currentBuildId);
    const revertFailures: string[] = [];
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
            value: safeCurrentBuild,
          },
        ]),
      ]);
      if (revertResult.exitCode !== 0) revertFailures.push(serviceName);
    }

    // The routing tier (image + manifest) was already reverted to the PREVIOUS build in
    // step 3b, but the pools are staying on the CURRENT one — roll the edge FORWARD
    // again so the abort leaves edge and pools consistent (the current build's manifest
    // snapshot was retained at the start of 3b, so image AND manifest are restorable).
    // Without this, the abort message would claim everything is still on the current
    // build while the edge kept serving the previous build's middleware/manifest.
    let edgeRestored = false;
    let edgeError = "";
    try {
      assertSafeBuildId(currentBuildId);
      await revertRoutingServiceToBuild({
        releaseName,
        targetBuildId: currentBuildId,
        registry: infra?.containerRegistry,
      });
      edgeRestored = true;
    } catch (err) {
      edgeError = err instanceof Error ? err.message : String(err);
    }

    console.error(`\n  ROLLBACK FAILED: traffic was NOT switched to the previous build.`);
    console.error(`  ${patchFailures.length} Service selector patch(es) failed:`);
    for (const f of patchFailures) {
      console.error(`    - service ${f.service}: ${f.stderr || "unknown error"}`);
    }
    if (revertFailures.length > 0) {
      console.error(`  WARNING: failed to restore selector(s): ${revertFailures.join(", ")}.`);
      console.error(`  Traffic may be split across builds; repair those Services manually.`);
    } else {
      console.error(`  Successful selector patches were restored to the current build.`);
    }
    if (edgeRestored) {
      console.error(`  The routing edge (image + manifest) was restored to the current build.`);
    } else {
      console.error(
        `  WARNING: could not roll the routing edge forward to the current build ` +
          `(${currentBuildId}): ${edgeError || "unknown error"}`,
      );
      console.error(
        `  The edge (ext_proc) is still serving build ${previousBuildId}'s middleware and ` +
          `routing manifest AGAINST pools serving ${currentBuildId}. Mismatched routes fall ` +
          `back to pool-local re-resolution (invariant 1), but edge middleware is the ` +
          `PREVIOUS build's until repaired.`,
      );
      console.error(`  Recover by re-running the rollback, or restore the edge manually:`);
      console.error(
        `    kubectl -n ${K8S_NAMESPACE} set image deployment/` +
          `${routingServiceDeploymentName(releaseName)} routing-service=` +
          `${infra?.containerRegistry ?? "<registry>"}/routing-service:${currentBuildId}`,
      );
    }
    console.error(`  Both builds were left scaled up.`);
    console.error(`  State was not changed. Investigate and re-run the rollback.\n`);
    process.exit(1);
  }

  // 4b. Swap state immediately after the traffic switch, while both builds are still healthy.
  // Committing BEFORE the (potentially minutes-long) CDN invalidation shrinks the window where
  // an interrupt leaves traffic on the previous build with state still claiming the current one
  // — mirrors deploy's patch → writeState → invalidate ordering. If persistence fails, traffic
  // already points at the previous build but either version remains safe to select during
  // recovery.
  try {
    await writeState(
      projectDir,
      {
        buildId: previousBuildId,
        previousBuildId: currentBuildId,
        // M13: carry the recorded per-build CDN tags verbatim — a rollback keeps both
        // builds in play, and each build's tag is only ever the one recorded at ITS
        // deploy (re-deriving under newer code is exactly the M13 failure).
        ...(state.cdnTags ? { cdnTags: state.cdnTags } : {}),
      },
      releaseName,
    );
  } catch (err) {
    console.error(`\n  Rollback traffic switch succeeded, but persisting state failed:`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error(
      `  The local state file was updated but the cluster ConfigMap was not. Restore cluster`,
    );
    console.error(
      `  connectivity and re-run so cluster/local state agree before the next deploy or rollback.\n`,
    );
    process.exit(1);
  }

  // 4c. Traffic now points at the previous build and state is committed. Invalidate the CDN
  // entries tagged for the build we rolled AWAY from (currentBuildId) so its stale content
  // stops serving. Best-effort and non-fatal — a failure just lets the TTL self-heal.
  const rbOutputDir = path.join(projectDir, ".k8s-adapter", "output");
  if (existsSync(path.join(rbOutputDir, "chart", "templates", "cdn-http-filter.yaml"))) {
    try {
      if (infra?.projectId) {
        await invalidateCdnBuildTag({
          projectId: infra.projectId,
          releaseName,
          outputDir: rbOutputDir,
          buildId: currentBuildId,
          // M13: the tag recorded when the rolled-away-from build deployed — never
          // re-derived here. Absent (pre-recording state) → full --path=/* purge.
          recordedTag: state.cdnTags?.[currentBuildId],
          run: execCapture,
          log: (m) => console.log(m),
        });
      }
    } catch (err) {
      console.log(
        `  ! CDN invalidation error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 6. State is durable; scale down every former-current Deployment. The HPA must be
  // deleted first (by its template-derived name — see the discovery-loop note) or the
  // autoscaler immediately rescales the parked build back to minReplicas.
  for (const currentDeploy of currentDeploys) {
    console.log(`  → Scaling down current build: ${currentDeploy.name}`);
    await execOrThrow("kubectl", [
      "delete",
      "hpa",
      currentDeploy.hpa,
      "-n",
      K8S_NAMESPACE,
      "--ignore-not-found",
    ]);
    await execOrThrow("kubectl", [
      "scale",
      `deployment/${currentDeploy.name}`,
      "-n",
      K8S_NAMESPACE,
      "--replicas=0",
    ]);
  }

  console.log(`\n✓ Rollback complete. Now serving build: ${previousBuildId}`);
  console.log(`  To roll forward again: npx adapter-k8s rollback`);
  console.log(`  To deploy new code:    npx adapter-k8s deploy\n`);
}
