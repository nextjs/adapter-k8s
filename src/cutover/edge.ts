// src/cutover/edge.ts
// GitOps PR2: the routing-edge primitives, moved verbatim from src/cli/rollback.ts
// (readRoutingServingConfig / retainLiveRoutingManifest / revertRoutingServiceToBuild /
// restoreRoutingSpec) and src/cli/deploy.ts (the restoreEdgeToPreviousBuild /
// edgeStatusLines abort closures, packaged as createEdgeRecovery). Both the CLI and the
// in-cluster cutover Job revert the edge through these functions; src/cli/rollback.ts
// re-exports them so its import surface (and the tests that mock it) are unchanged.
import { EXEC_TIMEOUTS, execCapture, execCaptureStdin } from "../cli/exec.js";
import { sanitizeForTerminal } from "../cli/terminal.js";
import {
  assertSafeBuildId,
  assertSafeImageRegistry,
  resolveK8sNamespace,
} from "../emit/templates/utils.js";
import {
  ROUTING_MANIFEST_SNAPSHOT_COMPONENT,
  ROUTING_MANIFEST_VOLUME_NAME,
  routingManifestSnapshotName,
  routingServiceDeploymentName,
} from "../emit/templates/routing-manifest-configmap.js";
// N87: internal dispatch secrets are per BUILD, so reverting the edge has to move its
// secretKeyRef with the image (see revertRoutingServiceToBuild).
import { INTERNAL_SECRET_KEY } from "../emit/templates/internal-secret.js";
import type { TargetPlatform } from "../target-platform.js";
import { readTrustedRoutingRevision } from "./routing-history.js";

// Annotation stamping the FULL build id onto retained snapshot ConfigMaps. Snapshot
// NAMES go through sanitizeK8sName (lowercase + 63-char truncation), so two different
// build ids can collide on the snapshot name; the annotation is what lets retention
// detect that and refuse to clobber a different build's manifest (deploy also guards
// the composed names up front — this is defense in depth at the point of overwrite).
export const SNAPSHOT_BUILD_ID_ANNOTATION = "adapter-k8s/build-id";

interface RoutingServingConfig {
  /**
   * The build id the edge currently serves. Named `imageTag` for historical reasons — it is no
   * longer read FROM the image tag: images are digest-pinned, so it comes from the pod's
   * NEXT_BUILD_ID env, with the tag as the pre-digest fallback.
   */
  imageTag: string;
  /**
   * The literal image reference the Deployment carries (tag- or digest-pinned). Kept verbatim
   * so a failed revert can be restored to exactly what was there — reconstructing it from the
   * build id would silently downgrade a digest-pinned edge to a tag.
   */
  image: string;
  /** ConfigMap the routing-manifest volume currently mounts. */
  manifestConfigMap: string;
  /**
   * N87: the Secret the routing container resolves INTERNAL_HEADER_SECRET from. Internal
   * dispatch secrets are per BUILD, so this moves with the image exactly like NEXT_BUILD_ID;
   * captured so a failed revert can be restored to the ref it actually had. `null` when the
   * Deployment carries no such env (an adapter version predating the injection).
   */
  internalSecretRef: string | null;
  /** Exact value of the routing pod's Kubernetes architecture selector, if present. */
  nodeArchitecture: string | null;
}

/**
 * N68: the outcome of reading the routing tier's serving config. "This release has no
 * routing tier" and "the routing Deployment could not be read" MUST stay distinct: both
 * used to collapse into `null`, so a kubectl/RBAC failure, empty output or malformed JSON
 * was reported to `retainLiveRoutingManifest` as `no-routing-tier` — and deploy then read
 * that as "nothing to retain" and proceeded, letting `helm upgrade` overwrite the stable
 * `<release>-routing-manifest` ConfigMap and destroy the rollback snapshot. That is
 * precisely the outcome the fail-closed retention posture (N30) was written to prevent, via
 * the same "a swallowed error becomes a meaningful value" route.
 */
type RoutingServingRead =
  | { status: "absent" }
  | { status: "read"; config: RoutingServingConfig; deploymentUid: string | undefined }
  | { status: "failed"; reason: string };

// Read what the routing tier is ACTUALLY serving (image tag + manifest source).
// `--ignore-not-found` is THE machine-readable absence signal: a genuinely absent
// Deployment (an app with no middleware/extension chain) exits 0 with empty stdout, so ANY
// other outcome — non-zero exit, unparseable JSON, a pod spec without the routing container
// or the manifest volume — is a read FAILURE and is reported as one. Deliberately not a
// substring match on stderr (the isAlreadyGoneError class of bug).
/**
 * Exported for tests: the build id it reports NAMES the retained manifest snapshot, and getting
 * it from the image reference broke once images became digest-pinned (see the NEXT_BUILD_ID note
 * inside).
 */
export async function readRoutingServingConfig(
  releaseName: string,
  configuredNamespace?: string,
): Promise<RoutingServingRead> {
  const namespace = resolveK8sNamespace(configuredNamespace);
  const deployName = routingServiceDeploymentName(releaseName);
  const res = await execCapture(
    "kubectl",
    ["get", "deployment", deployName, "-n", namespace, "--ignore-not-found", "-o", "json"],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (res.exitCode !== 0) {
    return {
      status: "failed",
      reason:
        `the routing Deployment ${deployName} could not be read (kubectl exited ` +
        `${res.exitCode}${res.stderr.trim() ? `: ${sanitizeForTerminal(res.stderr.trim())}` : ""}). ` +
        `--ignore-not-found makes a genuinely absent Deployment exit 0, so this is a ` +
        `connectivity/RBAC failure, NOT "this release has no routing tier"`,
    };
  }
  if (!res.stdout.trim()) return { status: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    return {
      status: "failed",
      reason:
        `kubectl returned output for the routing Deployment ${deployName} that is not valid ` +
        `JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const podSpec = (parsed as { spec?: { template?: { spec?: unknown } } })?.spec?.template?.spec as
    | { containers?: unknown; volumes?: unknown; nodeSelector?: unknown }
    | undefined;
  const containers: unknown[] = Array.isArray(podSpec?.containers) ? podSpec.containers : [];
  const volumes: unknown[] = Array.isArray(podSpec?.volumes) ? podSpec.volumes : [];
  const routingContainer = (containers as { name?: string; image?: string; env?: unknown }[]).find(
    (c) => c?.name === "routing-service",
  );
  const image = routingContainer?.image;
  const cmName = (volumes as { name?: string; configMap?: { name?: string } }[]).find(
    (v) => v?.name === ROUTING_MANIFEST_VOLUME_NAME,
  )?.configMap?.name;
  // The BUILD ID, which names the retained manifest snapshot. Read from the pod's own
  // NEXT_BUILD_ID env, NOT from the image reference: since images are digest-pinned (S7) the
  // reference is `<registry>/routing-service@sha256:<hex>`, and slicing after the last colon
  // yields the DIGEST HEX. That named the snapshot after the digest while rollback and cleanup
  // looked for snapshots named after state build ids — so a later failed deploy or rollback
  // could not restore the target manifest, and pairing the old image with the newer manifest
  // now makes the routing pod fail its startup parity check (S1) instead of silently serving.
  // The env carries the FULL, unsanitized id, which is exactly what the snapshot name needs.
  const envEntries = Array.isArray(routingContainer?.env)
    ? (routingContainer.env as {
        name?: string;
        value?: string;
        valueFrom?: { secretKeyRef?: { name?: string } };
      }[])
    : [];
  const envBuildId = envEntries.find((e) => e?.name === "NEXT_BUILD_ID")?.value;
  // N87: which per-build internal dispatch Secret the edge is currently resolving.
  const internalSecretRef =
    envEntries.find((e) => e?.name === "INTERNAL_HEADER_SECRET")?.valueFrom?.secretKeyRef?.name ??
    null;
  const nodeArchitecture =
    podSpec?.nodeSelector && typeof podSpec.nodeSelector === "object"
      ? ((podSpec.nodeSelector as Record<string, unknown>)["kubernetes.io/arch"] ?? null)
      : null;
  // A TAG-pinned image names its own build, and the image is what actually runs — so when the
  // reference carries a tag, that tag wins. The env is the source only for a DIGEST-pinned
  // image, where the reference cannot name a build at all.
  //
  // Order matters, and getting it backwards is what corrupted a snapshot on the live cluster:
  // preferring the env made a rollback (which patches the image) read the stale env of a
  // deployment whose image had already moved. Trusting the tag first is self-correcting even
  // for a Deployment last patched by an older CLI that did not update the env.
  const taggedBuildId =
    typeof image === "string" && image.includes(":") && !image.includes("@sha256:")
      ? image.slice(image.lastIndexOf(":") + 1)
      : "";
  if (taggedBuildId && envBuildId && taggedBuildId !== envBuildId) {
    console.warn(
      `  ! The routing Deployment's image tag (${taggedBuildId}) and NEXT_BUILD_ID ` +
        `(${envBuildId}) disagree. Trusting the image, which is what the pod runs. This means ` +
        `the Deployment was last patched by an adapter version that moved the image without ` +
        `the env; the next deploy or rollback re-syncs them.`,
    );
  }
  const tag = taggedBuildId || envBuildId;
  if (!tag || typeof cmName !== "string" || !cmName) {
    // Present but unrecognizable: without the image tag the snapshot cannot be NAMED and
    // without the mounted ConfigMap it cannot be SOURCED. Retention is impossible, which
    // is a failure — never "nothing to retain".
    return {
      status: "failed",
      reason:
        `the routing Deployment ${deployName} exists but does not carry a recognizable ` +
        `"routing-service" build id (NEXT_BUILD_ID env, or a tagged image for a pre-digest ` +
        `Deployment; image was ${JSON.stringify(image ?? null)}) and ` +
        `"${ROUTING_MANIFEST_VOLUME_NAME}" volume ConfigMap (${JSON.stringify(cmName ?? null)}), ` +
        `so the manifest it serves cannot be identified`,
    };
  }
  return {
    status: "read",
    deploymentUid: (parsed as { metadata?: { uid?: string } })?.metadata?.uid,
    config: {
      imageTag: tag,
      image: typeof image === "string" ? image : "",
      manifestConfigMap: cmName,
      internalSecretRef,
      nodeArchitecture: typeof nodeArchitecture === "string" ? nodeArchitecture : null,
    },
  };
}

/**
 * N30: the outcome of a retention attempt. `retainLiveRoutingManifest` used to fold "this
 * release has no routing tier" and "retention FAILED" into the same `null`, so deploy
 * could only warn — and a failed retention permanently destroys the rollback target's
 * manifest (helm then overwrites the stable `<release>-routing-manifest` ConfigMap).
 * Deploy now treats `failed` as fatal unless `--allow-unretained-manifest` is passed.
 */
export type RetainManifestResult =
  | { status: "retained"; snapshotName: string }
  | { status: "no-routing-tier" }
  | { status: "failed"; reason: string };

// Snapshot the manifest the routing tier currently serves into a build-named ConfigMap,
// so a later rollback can revert the edge to exactly this build's manifest. The stable
// `<release>-routing-manifest` ConfigMap is overwritten by every helm upgrade, and a
// rollback re-points the Deployment's volume at a snapshot — without this retention the
// previous build's manifest is unrecoverable and rollback can only revert the image.
// Returns a RetainManifestResult that distinguishes "no routing tier" from a genuine
// failure (N30) — deploy's fail-closed posture depends on telling them apart. Also used
// by deploy (pre-helm-upgrade) to retain the outgoing build.
export async function retainLiveRoutingManifest(
  releaseName: string,
  configuredNamespace?: string,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<RetainManifestResult> {
  const namespace = resolveK8sNamespace(configuredNamespace);
  const read = await readRoutingServingConfig(releaseName, namespace);
  // N68: absence (proven by --ignore-not-found) is the ONLY outcome that means "nothing to
  // retain". A read failure is a retention failure, which deploy treats as fatal unless
  // --allow-unretained-manifest — otherwise helm overwrites the stable ConfigMap and the
  // rollback target's manifest is gone for good.
  if (read.status === "absent") return { status: "no-routing-tier" };
  if (read.status === "failed") {
    log(
      `  ! Could not retain the routing manifest: ${read.reason}. This is NOT "no routing ` +
        `tier" — treating it as a retention failure.`,
    );
    return { status: "failed", reason: read.reason };
  }
  const serving = read.config;
  const snapshotName = routingManifestSnapshotName(releaseName, serving.imageTag);
  // A current chart renders the serving build's snapshot as a Helm-owned object. Merely
  // observing that it already has the right name is not retention: Helm deletes resources
  // that disappear from the next chart. Stamp the keep policy and classification labels
  // before upgrade so the outgoing routing ReplicaSet and rollback target keep mounting it.
  // This also migrates snapshots emitted before the chart carried the policy itself.
  if (serving.manifestConfigMap === snapshotName) {
    const annotated = await execCapture(
      "kubectl",
      [
        "annotate",
        "configmap",
        snapshotName,
        "-n",
        namespace,
        "helm.sh/resource-policy=keep",
        "--overwrite",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (annotated.exitCode !== 0) {
      return {
        status: "failed",
        reason: `could not retain the live snapshot ${snapshotName}: ${sanitizeForTerminal(annotated.stderr.trim()) || `kubectl annotate exited ${annotated.exitCode}`}`,
      };
    }
    const labeled = await execCapture(
      "kubectl",
      [
        "label",
        "configmap",
        snapshotName,
        "-n",
        namespace,
        `app.kubernetes.io/name=${releaseName}`,
        `app.kubernetes.io/component=${ROUTING_MANIFEST_SNAPSHOT_COMPONENT}`,
        "--overwrite",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (labeled.exitCode !== 0) {
      return {
        status: "failed",
        reason: `could not classify the live snapshot ${snapshotName}: ${sanitizeForTerminal(labeled.stderr.trim()) || `kubectl label exited ${labeled.exitCode}`}`,
      };
    }
    return { status: "retained", snapshotName };
  }
  // Overwrite protection: if a ConfigMap already exists under this snapshot name but is
  // stamped with a DIFFERENT build id, the two builds' snapshot names collide after
  // sanitization — overwriting would destroy that build's only retained manifest.
  // Abort loudly instead of silently clobbering it. Unstamped snapshots (written by
  // pre-annotation versions of this CLI) are overwritten as before, and a failed read
  // stays best-effort (the apply below surfaces real cluster trouble).
  const existing = await execCapture(
    "kubectl",
    ["get", "configmap", snapshotName, "-n", namespace, "--ignore-not-found", "-o", "json"],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
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
  const cm = await execCapture(
    "kubectl",
    ["get", "configmap", serving.manifestConfigMap, "-n", namespace, "-o", "json"],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  let data: unknown;
  if (cm.exitCode === 0 && cm.stdout.trim()) {
    try {
      data = JSON.parse(cm.stdout)?.data;
    } catch {
      data = undefined;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    const reason =
      `the live routing-manifest ConfigMap ${serving.manifestConfigMap} could not be read ` +
      `(kubectl exited ${cm.exitCode}${cm.stderr.trim() ? `: ${cm.stderr.trim()}` : ""})`;
    log(
      `  ! Could not retain the routing manifest for build ${serving.imageTag} ` +
        `(ConfigMap ${serving.manifestConfigMap} unreadable) — a rollback to this build ` +
        `would revert the edge image only.`,
    );
    return { status: "failed", reason };
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
        "app.kubernetes.io/component": ROUTING_MANIFEST_SNAPSHOT_COMPONENT,
      },
      // An ANNOTATION, not a label: build ids may exceed the 63-char label-value limit.
      annotations: {
        "helm.sh/resource-policy": "keep",
        [SNAPSHOT_BUILD_ID_ANNOTATION]: serving.imageTag,
      },
    },
    data,
  };
  // Via stdin: the manifest can approach the ~1 MiB ConfigMap limit, far over a safe
  // argv length, and secrets never go on argv.
  const applied = await execCaptureStdin(
    "kubectl",
    ["apply", "-n", namespace, "-f", "-"],
    JSON.stringify(snapshot),
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (applied.exitCode !== 0) {
    const reason = `kubectl apply of snapshot ${snapshotName} failed: ${
      sanitizeForTerminal(applied.stderr.trim()) || `exit ${applied.exitCode}`
    }`;
    log(
      `  ! Could not retain the routing manifest for build ${serving.imageTag}: ` +
        `${sanitizeForTerminal(applied.stderr.trim()) || `exit ${applied.exitCode}`} — a rollback to this ` +
        `build would revert the edge image only.`,
    );
    return { status: "failed", reason };
  }
  log(`  → Retained routing manifest for build ${serving.imageTag} → ${snapshotName}`);
  return { status: "retained", snapshotName };
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
//
// N25: exported because DEPLOY needs the identical operation. `helm upgrade` overwrites
// the stable `<release>-routing-manifest` ConfigMap the routing Deployment mounts BY NAME
// (kubelet volume sync propagates it even to un-rolled routing pods), so every deploy
// abort after helm left the ext_proc edge on the NEW build while the pools kept serving
// the previous one — indefinitely, while the error text claimed "The previous build is
// still serving traffic. No cutover performed."
export async function revertRoutingServiceToBuild(opts: {
  releaseName: string;
  namespace?: string;
  targetBuildId: string;
  registry: string | undefined;
  /**
   * Preserve the edge being replaced as another rollback target. Deploy recovery disables this:
   * a failed Helm command may have updated the stable manifest without updating the image, so
   * naming that uncertain pair after either build could overwrite a valid snapshot.
   */
  retainCurrentManifest?: boolean;
  /**
   * Legacy caller metadata; never an authority for the recovery image. Workload history
   * supplies the literal image reference, even when this ConfigMap-sourced value differs.
   */
  targetImageDigest?: string | undefined;
  /** Legacy caller metadata; recovery uses the architecture in trusted workload history. */
  targetPlatform?: TargetPlatform | undefined;
}): Promise<void> {
  const { releaseName, targetBuildId, registry } = opts;
  const namespace = resolveK8sNamespace(opts.namespace);
  // State and emit-metadata ConfigMaps are mutable by actors who cannot deploy code.
  // Syntax checks alone therefore cannot authorize the image that receives dispatch secrets.
  assertSafeBuildId(targetBuildId);
  const deployName = routingServiceDeploymentName(releaseName);
  // N68: same distinction as retention — a read failure here used to return silently, i.e.
  // report "this release has no routing tier" and let the caller believe the edge was
  // reverted (deploy's abort path prints "the routing edge was reverted") while the edge
  // kept serving the other build's middleware. Absence is exit 0 + empty stdout; anything
  // else throws so the caller can say what it does not know.
  const exists = await readRoutingServingConfig(releaseName, namespace);
  if (exists.status === "failed") {
    throw new Error(
      `Could not determine what the routing tier (${deployName}) is serving: ${exists.reason}. ` +
        `Refusing to guess — treating an unreadable Deployment as "no routing tier" would ` +
        `silently skip the edge revert and report it as done.`,
    );
  }
  if (exists.status === "absent") return; // no routing tier on this release

  if (registry !== undefined) assertSafeImageRegistry(registry);
  const target = await readTrustedRoutingRevision({
    deploymentName: deployName,
    deploymentUid: exists.deploymentUid,
    namespace,
    targetBuildId,
    live: exists.config,
  });
  if (!target.image.includes("@sha256:")) {
    console.warn(
      `  ! The retained workload revision for build ${targetBuildId} uses a mutable TAG. ` +
        `Recovery preserves that recorded reference; verify the tag has not moved.`,
    );
  }

  // Exactly what the edge is serving BEFORE this function changes anything, so a failed
  // rollout can be put back (see the rollout wait below). `exists.status` is "read" here:
  // "failed" threw and "absent" returned, both above.
  const priorSpec: RoutingSpecSnapshot = {
    buildId: exists.config.imageTag || null,
    image: exists.config.image || null,
    manifestConfigMap: exists.config.manifestConfigMap || null,
    internalSecretRef: exists.config.internalSecretRef,
    nodeArchitecture: exists.config.nodeArchitecture,
  };

  // Retain the manifest we are about to roll AWAY from, so the symmetric roll-forward
  // can restore it (its stable-ConfigMap content is otherwise lost on the next deploy).
  if (opts.retainCurrentManifest !== false) {
    await retainLiveRoutingManifest(releaseName, namespace);
  }

  const targetSnapshot = routingManifestSnapshotName(releaseName, targetBuildId);
  const snap = await execCapture(
    "kubectl",
    ["get", "configmap", targetSnapshot, "-n", namespace, "--ignore-not-found", "-o", "name"],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  const haveSnapshot = snap.exitCode === 0 && !!snap.stdout.trim();
  if (!haveSnapshot) {
    console.warn(
      `  ! No retained routing manifest for build ${targetBuildId} (${targetSnapshot} not ` +
        `found). Reverting the routing IMAGE only — the edge keeps the current manifest and ` +
        `mismatched routes fall back to pool-local re-resolution. Future deploys retain the ` +
        `manifest automatically.`,
    );
  }

  // Restore the Secret bound to this exact workload revision, including legacy stable
  // names. Guessing a Secret from mutable state would break the image/credential pairing.
  if (target.internalSecretRef) {
    const secret = await execCapture(
      "kubectl",
      [
        "get",
        "secret",
        target.internalSecretRef,
        "-n",
        namespace,
        "--ignore-not-found",
        "-o",
        "name",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (secret.exitCode !== 0 || !secret.stdout.trim()) {
      throw new Error(
        `Cannot recover routing build ${targetBuildId}: its recorded dispatch Secret is unavailable. Traffic was NOT switched.`,
      );
    }
  }
  const restoreNodeArchitecture = target.nodeArchitecture !== priorSpec.nodeArchitecture;
  const changeSecret = target.internalSecretRef !== priorSpec.internalSecretRef;
  const patch = {
    spec: {
      template: {
        spec: {
          ...(restoreNodeArchitecture
            ? {
                nodeSelector: {
                  "kubernetes.io/arch": target.nodeArchitecture,
                },
              }
            : {}),
          containers: [
            {
              name: "routing-service",
              image: target.image,
              // The pod's NEXT_BUILD_ID must move WITH the image. This patch used to change
              // only the image (and the volume), leaving the env at whatever the last
              // `helm upgrade` stamped — and readRoutingServingConfig reads that env to decide
              // which build the edge is serving. VERIFIED on the live cluster: after a
              // rollback the env still named the rolled-away-from build, so the NEXT
              // rollback's retention step copied the mounted manifest into a snapshot named
              // for the WRONG build — overwriting that build's rollback target with another
              // build's manifest. The routing pod then failed its startup parity check
              // (assertManifestMatchesImage) and crash-looped, which is how the corruption
              // surfaced rather than silently serving mismatched routes. A strategic-merge
              // patch matches env entries by `name`, so this replaces just this one variable.
              env: [
                { name: "NEXT_BUILD_ID", value: targetBuildId },
                // N87: same merge-by-name semantics; the live entry carries only `valueFrom`,
                // so this replaces the Secret it resolves from and nothing else.
                ...(changeSecret
                  ? [
                      {
                        name: "INTERNAL_HEADER_SECRET",
                        ...(target.internalSecretRef
                          ? {
                              valueFrom: {
                                secretKeyRef: {
                                  name: target.internalSecretRef,
                                  key: INTERNAL_SECRET_KEY,
                                },
                              },
                            }
                          : { $patch: "delete" }),
                      },
                    ]
                  : []),
              ],
            },
          ],
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
  const patched = await execCapture(
    "kubectl",
    [
      "patch",
      "deployment",
      deployName,
      "-n",
      namespace,
      "--type=strategic",
      // Same field-manager rationale as the Service selector patches below: helm owns this
      // Deployment, so the next `helm upgrade` must not conflict on the fields we flip here.
      "--field-manager=helm",
      "-p",
      JSON.stringify(patch),
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (patched.exitCode !== 0) {
    throw new Error(
      `Failed to revert the routing service (${deployName}): ` +
        `${sanitizeForTerminal(patched.stderr.trim()) || `exit ${patched.exitCode}`}. Traffic was NOT switched; ` +
        `the pools and the edge are still on the current build.`,
    );
  }
  // A stuck routing rollout is fatal (same posture as deploy's 7a-bis): with
  // maxUnavailable 0 the old ReplicaSet keeps serving, but reporting success while the
  // edge cannot roll would repeat the historical crashloop-for-months incident.
  //
  // OBSERVED LIVE: this used to throw here having ALREADY patched the Deployment, which left
  // the tiers split — pools serving one build, the edge rolled (or half-rolled) to another.
  // The site stayed up only because maxUnavailable 0 keeps the old ReplicaSet serving; with
  // `failureMode: closed` a routing outage in that window is 500s on every request. So a
  // failed rollout now RESTORES the edge to exactly the spec it had before this function
  // touched it, and says which of the two states the operator is in.
  const rollout = await execCapture(
    "kubectl",
    [
      "rollout",
      "status",
      `deployment/${deployName}`,
      "-n",
      namespace,
      `--timeout=${ROUTING_ROLLOUT_TIMEOUT_SECONDS}s`,
    ],
    { timeoutMs: EXEC_TIMEOUTS.rollout },
  );
  if (rollout.exitCode !== 0) {
    const detail = rollout.stderr.trim() || rollout.stdout.trim() || `exit ${rollout.exitCode}`;
    const restored = await restoreRoutingSpec(
      deployName,
      priorSpec,
      namespace,
      restoreNodeArchitecture,
    );
    throw new Error(
      `The routing service did not roll out to build ${targetBuildId} within ` +
        `${ROUTING_ROLLOUT_TIMEOUT_SECONDS}s: ${detail}\n` +
        (restored
          ? `  The edge was restored to what it was serving before (${priorSpec.buildId ?? "unknown build"}), ` +
            `so the pools and the edge still agree. Traffic was NOT switched.`
          : `  !! The edge could NOT be restored, so the pools and the edge may now be on ` +
            `DIFFERENT builds. Check \`kubectl -n ${namespace} describe deployment ` +
            `${deployName}\` and the routing pod logs — a manifest that does not match the ` +
            `image makes the pod refuse to start on purpose.`) +
        `\n  Traffic was NOT switched.`,
    );
  }
}

/**
 * How long to wait for the routing Deployment to roll. 120s was too short for a real Autopilot
 * cluster: every successful revert observed live logged several `1 of 2 new replicas have been
 * updated` cycles before converging, which means a slow-but-healthy rollout was
 * indistinguishable from a genuinely stuck one. Raised so the timeout means "stuck", not "busy".
 */
const ROUTING_ROLLOUT_TIMEOUT_SECONDS = 300;

/** The routing Deployment fields this module patches, captured before patching them. */
interface RoutingSpecSnapshot {
  buildId: string | null;
  image: string | null;
  manifestConfigMap: string | null;
  /** N87: the per-build internal dispatch Secret the container resolved from. */
  internalSecretRef: string | null;
  /** Exact prior selector value; null means the key was absent and must be removed. */
  nodeArchitecture: string | null;
}

/**
 * Put the routing Deployment back to `prior` after a failed rollout. Best-effort by design —
 * the caller reports either outcome, because "restored" and "possibly split" are different
 * situations for whoever is holding the pager. Returns false when nothing could be restored.
 */
async function restoreRoutingSpec(
  deployName: string,
  prior: RoutingSpecSnapshot,
  namespace: string,
  restoreNodeArchitecture: boolean,
): Promise<boolean> {
  if (!prior.image) return false;
  const patch = {
    spec: {
      template: {
        spec: {
          // Restore only fields this invocation changed; an unchanged selector needs no patch.
          // A historical revision without this key removes it, and restoration puts it back.
          ...(restoreNodeArchitecture
            ? {
                // Strategic merge treats null as deletion and preserves unrelated selectors.
                nodeSelector: {
                  "kubernetes.io/arch": prior.nodeArchitecture,
                },
              }
            : {}),
          containers: [
            {
              name: "routing-service",
              image: prior.image,
              // N87: the secretKeyRef is part of "what it was serving" too — the revert above
              // may have moved it, and leaving it on the target build's Secret while the image
              // goes back would put the restored edge on a secret the pools do not share.
              ...(prior.buildId || prior.internalSecretRef
                ? {
                    env: [
                      ...(prior.buildId ? [{ name: "NEXT_BUILD_ID", value: prior.buildId }] : []),
                      {
                        name: "INTERNAL_HEADER_SECRET",
                        ...(prior.internalSecretRef
                          ? {
                              valueFrom: {
                                secretKeyRef: {
                                  name: prior.internalSecretRef,
                                  key: INTERNAL_SECRET_KEY,
                                },
                              },
                            }
                          : { $patch: "delete" }),
                      },
                    ],
                  }
                : {}),
            },
          ],
          ...(prior.manifestConfigMap
            ? {
                volumes: [
                  {
                    name: ROUTING_MANIFEST_VOLUME_NAME,
                    configMap: { name: prior.manifestConfigMap },
                  },
                ],
              }
            : {}),
        },
      },
    },
  };
  const res = await execCapture(
    "kubectl",
    [
      "patch",
      "deployment",
      deployName,
      "-n",
      namespace,
      "--type=strategic",
      "--field-manager=helm",
      "-p",
      JSON.stringify(patch),
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  return res.exitCode === 0;
}

/** The deploy-side edge recovery pair plus the flag marking that Helm was invoked. */
export interface EdgeRecoveryHandle {
  /**
   * Re-point the routing tier (image + retained manifest snapshot) at the previous build after
   * Helm was invoked. A non-zero Helm exit is not proof that nothing changed: client-side Helm
   * can fail after applying earlier resources, and server-side apply can return an error after
   * admission or transport uncertainty. Recovery therefore starts when mutation is attempted,
   * not only after the command reports success.
   */
  restoreEdgeToPreviousBuild(): Promise<{ attempted: boolean; restored: boolean; error: string }>;
  /** Human-readable tail for an abort message, describing the edge's ACTUAL state. */
  edgeStatusLines(r: { attempted: boolean; restored: boolean; error: string }): string[];
  /** Arms restoreEdgeToPreviousBuild: from this point the edge MAY run the new build. */
  markHelmMutationAttempted(): void;
}

/**
 * GitOps PR2: the shared abort machinery every cutover gate depends on, moved verbatim from
 * runDeploy's inline closures (N25/N68 lineage). The revert function is INJECTED rather than
 * imported so the CLI keeps routing the call through src/cli/rollback.js — the module boundary
 * deploy's orchestration tests mock — while the cutover Job wires the same factory to the
 * function in this module directly.
 */
export function createEdgeRecovery(opts: {
  releaseName: string;
  namespace: string;
  buildId: string;
  previousBuildId: string | null;
  registry: string | undefined;
  targetImageDigest: string | undefined;
  targetPlatform: TargetPlatform | undefined;
  revertRoutingService: typeof revertRoutingServiceToBuild;
}): EdgeRecoveryHandle {
  const { releaseName, namespace, buildId, previousBuildId, registry } = opts;
  let helmMutationAttempted = false;
  const restoreEdgeToPreviousBuild = async (): Promise<{
    attempted: boolean;
    restored: boolean;
    error: string;
  }> => {
    if (!helmMutationAttempted || !previousBuildId || previousBuildId === buildId) {
      return { attempted: false, restored: false, error: "" };
    }
    try {
      await opts.revertRoutingService({
        releaseName,
        namespace,
        targetBuildId: previousBuildId,
        registry,
        targetImageDigest: opts.targetImageDigest,
        targetPlatform: opts.targetPlatform,
        // The outgoing manifest was snapshotted before Helm. Do not retain the uncertain
        // image/manifest pair left by a failed or aborted deploy under either build's name.
        retainCurrentManifest: false,
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
      `    kubectl -n ${namespace} set image deployment/` +
        `${routingServiceDeploymentName(releaseName)} routing-service=` +
        `${registry}/routing-service:${previousBuildId}`,
    ];
  };

  return {
    restoreEdgeToPreviousBuild,
    edgeStatusLines,
    markHelmMutationAttempted: () => {
      helmMutationAttempted = true;
    },
  };
}
