// src/cli/rollback.ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execCapture, execCaptureStdin, execOrThrow } from "./exec.js";
import { readState, writeState } from "./state.js";
import { discoverBuildPools, recordedBuildPools } from "./pool-topology.js";
import { invalidateCdnBuildTag } from "./cdn-invalidate.js";
import {
  assertSafeBuildId,
  assertSafeImageRegistry,
  poolResourceNames,
  sanitizeK8sName,
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
import {
  INTERNAL_SECRET_KEY,
  internalSecretName,
  legacyInternalSecretName,
} from "../emit/templates/internal-secret.js";
import {
  assertSafeInfrastructure,
  infrastructurePath,
  outputDirName,
} from "./infrastructure-validation.js";
import { targetArchitecture, type TargetPlatform } from "../target-platform.js";

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
  | { status: "read"; config: RoutingServingConfig }
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
  const res = await execCapture("kubectl", [
    "get",
    "deployment",
    deployName,
    "-n",
    namespace,
    "--ignore-not-found",
    "-o",
    "json",
  ]);
  if (res.exitCode !== 0) {
    return {
      status: "failed",
      reason:
        `the routing Deployment ${deployName} could not be read (kubectl exited ` +
        `${res.exitCode}${res.stderr.trim() ? `: ${res.stderr.trim()}` : ""}). ` +
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
    const annotated = await execCapture("kubectl", [
      "annotate",
      "configmap",
      snapshotName,
      "-n",
      namespace,
      "helm.sh/resource-policy=keep",
      "--overwrite",
    ]);
    if (annotated.exitCode !== 0) {
      return {
        status: "failed",
        reason: `could not retain the live snapshot ${snapshotName}: ${annotated.stderr.trim() || `kubectl annotate exited ${annotated.exitCode}`}`,
      };
    }
    const labeled = await execCapture("kubectl", [
      "label",
      "configmap",
      snapshotName,
      "-n",
      namespace,
      `app.kubernetes.io/name=${releaseName}`,
      `app.kubernetes.io/component=${ROUTING_MANIFEST_SNAPSHOT_COMPONENT}`,
      "--overwrite",
    ]);
    if (labeled.exitCode !== 0) {
      return {
        status: "failed",
        reason: `could not classify the live snapshot ${snapshotName}: ${labeled.stderr.trim() || `kubectl label exited ${labeled.exitCode}`}`,
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
  const existing = await execCapture("kubectl", [
    "get",
    "configmap",
    snapshotName,
    "-n",
    namespace,
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
    namespace,
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
  );
  if (applied.exitCode !== 0) {
    const reason = `kubectl apply of snapshot ${snapshotName} failed: ${
      applied.stderr.trim() || `exit ${applied.exitCode}`
    }`;
    log(
      `  ! Could not retain the routing manifest for build ${serving.imageTag}: ` +
        `${applied.stderr.trim() || `exit ${applied.exitCode}`} — a rollback to this ` +
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
   * The target build's recorded routing-image digest (`AdapterState.routingImageDigests`), when
   * one exists. Without it the reference can only be a TAG, which leaves a rolled-back edge one
   * step less immutable than a freshly deployed one.
   */
  targetImageDigest?: string | undefined;
  /** The target build's recorded platform. Unknown legacy builds leave the selector alone. */
  targetPlatform?: TargetPlatform | undefined;
}): Promise<void> {
  const { releaseName, targetBuildId, registry, targetImageDigest, targetPlatform } = opts;
  const namespace = resolveK8sNamespace(opts.namespace);
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

  if (!registry) {
    throw new Error(
      `infrastructure.json is missing containerRegistry, so the routing service image ` +
        `reference cannot be formed. Restore it (re-run \`npx adapter-k8s init\`) and ` +
        `re-run the rollback. Traffic was NOT switched.`,
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
  const snap = await execCapture("kubectl", [
    "get",
    "configmap",
    targetSnapshot,
    "-n",
    namespace,
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

  // Digest when the deploy that pushed this build recorded one; tag otherwise (a build from
  // before digests were recorded, where the tag is all that identifies it).
  const image = targetImageDigest
    ? `${registry}/routing-service@${targetImageDigest}`
    : `${registry}/routing-service:${targetBuildId}`;
  if (!targetImageDigest) {
    console.warn(
      `  ! No recorded routing-image digest for build ${targetBuildId} — reverting the edge by ` +
        `TAG. A retag of that tag would change what the edge runs on its next restart; the ` +
        `next deploy records a digest so a later rollback can pin it.`,
    );
  }
  if (!targetPlatform) {
    console.warn(
      `  ! No recorded target platform for build ${targetBuildId}. This build predates ` +
        `platform-aware deploy state, so the routing Deployment's kubernetes.io/arch ` +
        `selector will NOT be changed. Verify that the live selector can run this image; ` +
        `new builds record platform provenance, but this legacy build ID remains unknown.`,
    );
  }
  // N87: the internal dispatch secret is per BUILD, so the edge's secretKeyRef must move with
  // the image for the same reason NEXT_BUILD_ID does — otherwise a reverted edge presents the
  // rolled-away-from build's secret to the rolled-back pools, which reject it and re-resolve
  // every request locally (fail-safe per invariant 1, but middleware then runs TWICE per
  // request for as long as the rollback lasts — and a rollback is not the moment to double
  // the middleware bill). Only patched when the target's Secret actually EXISTS: pointing a
  // container at a missing Secret is CreateContainerConfigError, i.e. it would turn a
  // degraded edge into a dead one. A build deployed before per-build names used the legacy
  // stable name, which deploy preserves (`helm.sh/resource-policy: keep`), so try that too.
  let targetSecretRef: string | null = null;
  for (const candidate of [
    internalSecretName(releaseName, targetBuildId),
    legacyInternalSecretName(releaseName),
  ]) {
    const got = await execCapture("kubectl", [
      "get",
      "secret",
      candidate,
      "-n",
      namespace,
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    if (got.exitCode === 0 && got.stdout.trim()) {
      targetSecretRef = candidate;
      break;
    }
  }
  if (!targetSecretRef) {
    console.warn(
      `  ! No internal dispatch Secret found for build ${targetBuildId} ` +
        `(${internalSecretName(releaseName, targetBuildId)}). The edge keeps its current ` +
        `secret, so the rolled-back pools will reject its dispatch headers and re-resolve ` +
        `every request locally — correct (invariant 1), but middleware runs twice per request ` +
        `until the next deploy.`,
    );
  } else if (targetSecretRef === priorSpec.internalSecretRef) {
    // Already pointing at the right Secret (e.g. a legacy release where both builds share
    // the stable name) — leave the env alone rather than patching it to itself.
    targetSecretRef = null;
  }
  const patch = {
    spec: {
      template: {
        spec: {
          ...(targetPlatform
            ? {
                nodeSelector: {
                  "kubernetes.io/arch": targetArchitecture(targetPlatform),
                },
              }
            : {}),
          containers: [
            {
              name: "routing-service",
              image,
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
                ...(targetSecretRef
                  ? [
                      {
                        name: "INTERNAL_HEADER_SECRET",
                        valueFrom: {
                          secretKeyRef: { name: targetSecretRef, key: INTERNAL_SECRET_KEY },
                        },
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
  const patched = await execCapture("kubectl", [
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
  //
  // OBSERVED LIVE: this used to throw here having ALREADY patched the Deployment, which left
  // the tiers split — pools serving one build, the edge rolled (or half-rolled) to another.
  // The site stayed up only because maxUnavailable 0 keeps the old ReplicaSet serving; with
  // `failureMode: closed` a routing outage in that window is 500s on every request. So a
  // failed rollout now RESTORES the edge to exactly the spec it had before this function
  // touched it, and says which of the two states the operator is in.
  const rollout = await execCapture("kubectl", [
    "rollout",
    "status",
    `deployment/${deployName}`,
    "-n",
    namespace,
    `--timeout=${ROUTING_ROLLOUT_TIMEOUT_SECONDS}s`,
  ]);
  if (rollout.exitCode !== 0) {
    const detail = rollout.stderr.trim() || rollout.stdout.trim() || `exit ${rollout.exitCode}`;
    const restored = await restoreRoutingSpec(
      deployName,
      priorSpec,
      namespace,
      targetPlatform !== undefined,
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
          // Restore only fields this invocation changed. A legacy target with unknown platform
          // deliberately leaves the selector alone in the forward patch, so touching it here
          // would break patch/restore symmetry and trust parser fidelity unnecessarily.
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
                      ...(prior.internalSecretRef
                        ? [
                            {
                              name: "INTERNAL_HEADER_SECRET",
                              valueFrom: {
                                secretKeyRef: {
                                  name: prior.internalSecretRef,
                                  key: INTERNAL_SECRET_KEY,
                                },
                              },
                            },
                          ]
                        : []),
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
  const res = await execCapture("kubectl", [
    "patch",
    "deployment",
    deployName,
    "-n",
    namespace,
    "--type=strategic",
    "--field-manager=helm",
    "-p",
    JSON.stringify(patch),
  ]);
  return res.exitCode === 0;
}

/**
 * N26: the capacity a rolled-back build must come back at. Rollback used to scale the
 * target to a hardcoded 2 replicas and (re)create its HPA from the chart defaults
 * (min 1 / max 3): roll back a build that was serving 20 under load and the site returns
 * on 2 pods that can autoscale to 3 — a self-inflicted overload during an incident.
 * Deploy's mirror of this decision (the retained-manifest replica probe) refuses to guess
 * at all; here the guess is bounded by what the CURRENT build is actually running.
 *
 * Pure so the arithmetic is unit-testable without a cluster.
 */
export const ROLLBACK_MIN_REPLICAS = 2;

export interface LiveCapacity {
  /** `.spec.replicas` of the current build's Deployment (null = unreadable/absent). */
  specReplicas: number | null;
  /** `.status.readyReplicas` — pods actually serving right now. */
  readyReplicas: number | null;
  /** HPA `.status.desiredReplicas` — what the autoscaler had decided under load. */
  hpaDesired: number | null;
  /** HPA `.spec.maxReplicas` — the ceiling the current build was allowed to reach. */
  hpaMax: number | null;
}

export function planRollbackCapacity(
  observed: LiveCapacity,
  scaling: { min: number; max: number; targetCPU: number },
): { replicas: number; min: number; max: number } {
  const live = Math.max(
    observed.specReplicas ?? 0,
    observed.readyReplicas ?? 0,
    observed.hpaDesired ?? 0,
  );
  const replicas = Math.max(ROLLBACK_MIN_REPLICAS, scaling.min, live);
  // The HPA must not immediately undo the scale-up (min) and must be able to grow past
  // where the current build already was (max). The next deploy omits this HPA when it parks
  // the build again, so this widening is scoped to the incident.
  return { replicas, min: replicas, max: Math.max(scaling.max, observed.hpaMax ?? 0, replicas) };
}

/**
 * Read what the CURRENT build is running, machine-readably: `--ignore-not-found` makes a
 * genuinely absent Deployment/HPA exit 0 with empty stdout, so a non-zero exit is a real
 * read failure. A read failure does NOT abort the rollback (the current build may be the
 * broken thing we are escaping) — it degrades to the configured floor and says so.
 */
async function readLiveCapacity(
  releaseName: string,
  pool: string,
  currentBuildId: string,
  namespace: string,
): Promise<{ observed: LiveCapacity; unreadable: string[] }> {
  const { deployment, hpa } = poolResourceNames(releaseName, pool, currentBuildId);
  const unreadable: string[] = [];
  const observed: LiveCapacity = {
    specReplicas: null,
    readyReplicas: null,
    hpaDesired: null,
    hpaMax: null,
  };

  const dep = await execCapture("kubectl", [
    "get",
    "deployment",
    deployment,
    "-n",
    namespace,
    "--ignore-not-found",
    "-o",
    "jsonpath={.metadata.name}|{.spec.replicas}|{.status.readyReplicas}",
  ]);
  if (dep.exitCode !== 0) unreadable.push(`deployment ${deployment}`);
  else {
    const [name, spec, ready] = dep.stdout.trim().split("|");
    if (name) {
      const s = parseInt(spec ?? "", 10);
      const r = parseInt(ready ?? "", 10);
      if (Number.isFinite(s)) observed.specReplicas = s;
      if (Number.isFinite(r)) observed.readyReplicas = r;
    }
  }

  const hpaRes = await execCapture("kubectl", [
    "get",
    "hpa",
    hpa,
    "-n",
    namespace,
    "--ignore-not-found",
    "-o",
    "jsonpath={.metadata.name}|{.status.desiredReplicas}|{.spec.maxReplicas}",
  ]);
  if (hpaRes.exitCode !== 0) unreadable.push(`hpa ${hpa}`);
  else {
    const [name, desired, max] = hpaRes.stdout.trim().split("|");
    if (name) {
      const d = parseInt(desired ?? "", 10);
      const m = parseInt(max ?? "", 10);
      if (Number.isFinite(d)) observed.hpaDesired = d;
      if (Number.isFinite(m)) observed.hpaMax = m;
    }
  }

  return { observed, unreadable };
}

export async function runRollback(options: {
  projectDir: string;
  releaseName: string;
  dryRun?: boolean;
}): Promise<void> {
  const { projectDir, releaseName, dryRun } = options;

  const infraPath = infrastructurePath(projectDir);
  const infra = existsSync(infraPath) ? JSON.parse(readFileSync(infraPath, "utf-8")) : undefined;
  // S13: validate before these reach a gcloud/kubectl argv.
  assertSafeInfrastructure(infra);
  const namespace = resolveK8sNamespace(infra?.namespace);

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

  const state = await readState(projectDir, releaseName, {
    ...(dryRun ? { localOnly: true } : {}),
    namespace,
  });
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

  // N70: rollback has TWO independent topologies. Local build-metadata describes whichever
  // build happened to run last in this checkout, not necessarily the rollback target (and a
  // renamed pool makes the two sets differ by definition). Current states record both exact
  // build-scoped sets. Legacy states are migrated from immutable versioned Deployments; dry-run
  // cannot perform that cluster read and fails closed rather than fabricating a plan.
  let poolNames = recordedBuildPools(state, previousBuildId);
  let currentPoolNames = recordedBuildPools(state, currentBuildId);
  if (dryRun && (!poolNames || !currentPoolNames)) {
    throw new Error(
      `Deploy state predates per-build pool topology for ${!poolNames ? `rollback target "${previousBuildId}"` : `current build "${currentBuildId}"`}. ` +
        `Dry-run cannot recover it without cluster access; run rollback without --dry-run to ` +
        `migrate the state, or restore poolTopologies in .k8s-adapter/state.json.`,
    );
  }
  if (!poolNames) {
    poolNames = await discoverBuildPools(releaseName, previousBuildId, namespace);
    console.warn(
      `  ! Recovered legacy pool topology for rollback target "${previousBuildId}" from ` +
        `its versioned Deployments: ${poolNames.join(", ")}.`,
    );
  }
  if (!currentPoolNames) {
    currentPoolNames = await discoverBuildPools(releaseName, currentBuildId, namespace);
    console.warn(
      `  ! Recovered legacy pool topology for current build "${currentBuildId}" from its ` +
        `versioned Deployments: ${currentPoolNames.join(", ")}.`,
    );
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

  console.log(`\nRolling back: ${currentBuildId} → ${previousBuildId}\n`);

  // Find the previous deployment
  const deploysResult = await execCapture("kubectl", [
    "get",
    "deployments",
    "-n",
    namespace,
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
  const valuesPath = path.join(projectDir, ".k8s-adapter", outputDirName(), "chart", "values.yaml");
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
    if (discovered.has(prev.deployment)) {
      previousDeploys.push({ pool, name: prev.deployment, hpa: prev.hpa });
    } else missingPrev.push(pool);
  }
  for (const pool of currentPoolNames) {
    const curr = poolResourceNames(releaseName, pool, currentBuildId);
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

  // 1. Scale up every pool's previous deployment — to at least the capacity the CURRENT
  // build is running (N26), never the old hardcoded 2. Done BEFORE any selector flip so
  // the target is already at size when traffic arrives.
  const capacityByPool = new Map<string, { replicas: number; min: number; max: number }>();
  for (const previousDeploy of previousDeploys) {
    const scaling = scalingByPool.get(previousDeploy.pool) ?? { min: 1, max: 3, targetCPU: 80 };
    const { observed, unreadable } = await readLiveCapacity(
      releaseName,
      previousDeploy.pool,
      currentBuildId,
      namespace,
    );
    if (unreadable.length > 0) {
      console.warn(
        `  ! Could not read the current build's live capacity (${unreadable.join(", ")}) — ` +
          `scaling ${previousDeploy.name} to the configured floor instead. If the current ` +
          `build was serving more than that, scale the rollback target up manually.`,
      );
    }
    const plan = planRollbackCapacity(observed, scaling);
    capacityByPool.set(previousDeploy.pool, plan);
    const observedNote =
      observed.specReplicas !== null || observed.hpaDesired !== null
        ? ` (current build: spec=${observed.specReplicas ?? "?"}, ready=${
            observed.readyReplicas ?? "?"
          }, hpaDesired=${observed.hpaDesired ?? "?"})`
        : "";
    console.log(
      `  → Scaling up previous build: ${previousDeploy.name} → ${plan.replicas} replicas${observedNote}`,
    );
    await execOrThrow("kubectl", [
      "scale",
      `deployment/${previousDeploy.name}`,
      "-n",
      namespace,
      `--replicas=${plan.replicas}`,
    ]);
  }

  // Recreate the rollback build's HPA. Deploy removes it before parking that build at zero,
  // otherwise the autoscaler would immediately raise it back to minReplicas. The name comes
  // from poolResourceNames so the existence probe finds the HPA the template actually
  // rendered (see the divergence note at the discovery loop above).
  // N26: min/max come from planRollbackCapacity, not the chart defaults — an HPA capped at
  // the default max 3 would drag a 20-replica workload back down mid-incident. An HPA that
  // already exists is WIDENED (its min/max could be the parked build's stale values).
  for (const previousDeploy of previousDeploys) {
    const hpaName = previousDeploy.hpa;
    const scaling = scalingByPool.get(previousDeploy.pool) ?? { min: 1, max: 3, targetCPU: 80 };
    const plan = capacityByPool.get(previousDeploy.pool) ?? {
      replicas: ROLLBACK_MIN_REPLICAS,
      min: scaling.min,
      max: scaling.max,
    };
    const hpa = await execCapture("kubectl", [
      "get",
      "hpa",
      hpaName,
      "-n",
      namespace,
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    if (!hpa.stdout.trim()) {
      await execOrThrow("kubectl", [
        "autoscale",
        "deployment",
        previousDeploy.name,
        "-n",
        namespace,
        `--name=${hpaName}`,
        `--min=${plan.min}`,
        `--max=${plan.max}`,
        `--cpu=${scaling.targetCPU}%`,
      ]);
    } else {
      const widen = await execCapture("kubectl", [
        "patch",
        "hpa",
        hpaName,
        "-n",
        namespace,
        "--type=merge",
        // Same field-manager rationale as the Service/Deployment patches: helm owns the
        // chart-rendered HPA, so the next `helm upgrade` must not conflict here.
        "--field-manager=helm",
        "-p",
        JSON.stringify({ spec: { minReplicas: plan.min, maxReplicas: plan.max } }),
      ]);
      if (widen.exitCode !== 0) {
        console.warn(
          `  ! Could not raise ${hpaName} to min=${plan.min}/max=${plan.max}: ` +
            `${widen.stderr.trim() || `exit ${widen.exitCode}`} — the rollback target may ` +
            `autoscale back below the capacity the current build was serving.`,
        );
      }
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
      namespace,
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
      namespace,
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
          namespace,
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
        `up; investigate (kubectl logs -n ${namespace} -l ` +
        `app.kubernetes.io/version=${safePreviousBuild}) and ` +
        `re-run the rollback.`,
    );
  }

  // N70: Helm is not rolled back, so HTTPRoute still carries the former-current topology.
  // When pool sets differ, every stable Service that route may reference must be redirected to
  // a real target-build pool before current-only Deployments are parked. Capture the exact live
  // selectors first so a partial patch failure can restore them byte-for-byte; guessing
  // `component=<service suffix>` is wrong after one topology-changing rollback/roll-forward.
  const targetPoolSet = new Set(poolNames);
  const currentOnlyPools = currentPoolNames.filter((pool) => !targetPoolSet.has(pool));
  const topologyChanged =
    currentOnlyPools.length > 0 || poolNames.some((pool) => !currentPoolNames.includes(pool));
  const originalSelectors = new Map<string, Record<string, string>>();
  if (topologyChanged) {
    for (const pool of new Set([...poolNames, ...currentOnlyPools])) {
      const serviceName = sanitizeK8sName(`${releaseName}-${pool}`);
      const read = await execCapture("kubectl", [
        "get",
        "service",
        serviceName,
        "-n",
        namespace,
        "-o",
        "json",
      ]);
      let selector: unknown;
      if (read.exitCode === 0) {
        try {
          selector = JSON.parse(read.stdout)?.spec?.selector;
        } catch {
          selector = undefined;
        }
      }
      if (
        !selector ||
        typeof selector !== "object" ||
        Array.isArray(selector) ||
        Object.values(selector).some((value) => typeof value !== "string")
      ) {
        throw new Error(
          `Could not read the exact selector for topology-changing rollback Service ` +
            `${serviceName} (kubectl exited ${read.exitCode}${read.stderr.trim() ? `: ${read.stderr.trim()}` : ""}). ` +
            `Traffic was NOT switched; refusing to patch selectors without a reversible ` +
            `snapshot.`,
        );
      }
      originalSelectors.set(serviceName, selector as Record<string, string>);
    }
  }

  // 3b. Revert the routing tier (image + manifest) to the previous build BEFORE flipping
  // pool traffic — the same order deploy applies (edge first, selectors second), so the
  // middleware/manifest never trails the pools by more than one step.
  assertSafeBuildId(previousBuildId);
  if (infra?.containerRegistry) assertSafeImageRegistry(infra.containerRegistry);
  await revertRoutingServiceToBuild({
    releaseName,
    namespace,
    targetBuildId: previousBuildId,
    registry: infra?.containerRegistry,
    targetImageDigest: state.routingImageDigests?.[previousBuildId],
    targetPlatform: state.targetPlatforms?.[previousBuildId],
  });

  // 4. Switch traffic: patch active Service selectors to the previous build.
  // The selector value MUST use the same sanitizer that stamped the pod label
  // (sanitizeK8sName prepends `b-` when the build id starts with a non-letter). A
  // divergent value (the old inline sanitizer omitted the `b-` prefix) matches no pods,
  // draining the active Service to zero endpoints and 503'ing the site on rollback.
  // (safePreviousBuild is computed once in step 3 above and reused here.)

  // Switch each target Service (`<release>-<pool>`) by NAME, then redirect Services that only
  // exist in the still-installed HTTPRoute topology to a real target pool. (The template's
  // `managed-by: adapter-k8s-active` label is overwritten by Helm to `managed-by: Helm`,
  // so a label selector would match nothing, patch ZERO Services, skip the failure guard,
  // and strand the site when the current build is scaled down.)
  const patchFailures: { service: string; stderr: string }[] = [];
  const patchedServices: { service: string; pool: string }[] = [];
  console.log(`  → Switching traffic to previous build...`);
  const fallbackTargetPool = poolNames[0]!;
  const serviceDestinations = [
    ...poolNames.map((pool) => ({ servicePool: pool, targetPool: pool })),
    ...currentOnlyPools.map((pool) => ({ servicePool: pool, targetPool: fallbackTargetPool })),
  ];
  for (const { servicePool, targetPool } of serviceDestinations) {
    const svcName = sanitizeK8sName(`${releaseName}-${servicePool}`);
    const patchResult = await execCapture("kubectl", [
      "patch",
      "service",
      svcName,
      "-n",
      namespace,
      "--type=json",
      // --force-conflicts is NOT a valid `kubectl patch` flag (only `apply
      // --server-side` accepts it); a JSON patch needs no conflict override.
      "--field-manager=helm",
      "-p",
      JSON.stringify([
        {
          op: "replace",
          path: "/spec/selector/app.kubernetes.io~1component",
          value: targetPool,
        },
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
      patchedServices.push({ service: svcName, pool: servicePool });
    }
  }

  // If any selector patch failed, traffic did not switch to the previous build.
  // Scaling the current deployment to 0 now would strand the still-current Services
  // with zero endpoints. Abort before scale-down, leaving the current build serving.
  if (patchFailures.length > 0) {
    const safeCurrentBuild = sanitizeK8sName(currentBuildId);
    const revertFailures: string[] = [];
    for (const { service: serviceName, pool } of patchedServices) {
      const original = originalSelectors.get(serviceName);
      const revertResult = await execCapture("kubectl", [
        "patch",
        "service",
        serviceName,
        "-n",
        namespace,
        "--type=json",
        "--field-manager=helm",
        "-p",
        JSON.stringify(
          original
            ? [{ op: "replace", path: "/spec/selector", value: original }]
            : [
                {
                  op: "replace",
                  path: "/spec/selector/app.kubernetes.io~1component",
                  value: pool,
                },
                {
                  op: "replace",
                  path: "/spec/selector/app.kubernetes.io~1version",
                  value: safeCurrentBuild,
                },
              ],
        ),
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
        namespace,
        targetBuildId: currentBuildId,
        registry: infra?.containerRegistry,
        targetImageDigest: state.routingImageDigests?.[currentBuildId],
        targetPlatform: state.targetPlatforms?.[currentBuildId],
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
        `    kubectl -n ${namespace} set image deployment/` +
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
    // A rollback swaps the two build pointers; it does not create a new build. Preserve every
    // other durable state field by default so per-build provenance remains available in BOTH
    // directions. Keeping an allowlist here already lost routingImageDigests and
    // unretainedManifestBuilds in production, which made the next rollback downgrade the edge
    // from an immutable digest to a mutable tag and hid the retained-manifest warning.
    //
    // generation/updatedAt belong to writeState, and readinessPathSupported is the one
    // deliberate exception: it describes the build that is NOW serving, so rolling back to an
    // older build must conservatively clear it (see below).
    const { generation, updatedAt, readinessPathSupported, ...durableState } = state;
    void updatedAt;
    void readinessPathSupported;
    await writeState(
      projectDir,
      {
        ...durableState,
        buildId: previousBuildId,
        previousBuildId: currentBuildId,
        poolTopologies: {
          [previousBuildId]: [...poolNames],
          [currentBuildId]: [...currentPoolNames],
        },
        // The pointer swap keeps these same two build artifacts in play. Prune any stale
        // provenance while preserving the exact platform recorded for both directions.
        ...(state.targetPlatforms
          ? {
              targetPlatforms: Object.fromEntries(
                Object.entries(state.targetPlatforms).filter(([build]) =>
                  [currentBuildId, previousBuildId].includes(build),
                ),
              ),
            }
          : {}),
        // `readinessPathSupported` is deliberately NOT carried forward. It means "the build
        // now serving answers /readyz", and after a rollback the serving build is an OLDER
        // one that may predate it — so dropping it is the conservative answer, and the next
        // deploy keeps the load balancer on /healthz for one cycle before flipping. OBSERVED
        // on the live cluster: deploy set it, a rollback cleared it, and the following deploy
        // therefore probed /healthz again — correct, and self-healing one cycle later. Do not
        // "fix" this by preserving it: that would point the load balancer at /readyz on a
        // build that may not serve it, which is the outage this migration exists to avoid.
        // N69: the generation this write is based on — writeState treats it as a floor, so
        // the local file stays provably newer than the cluster ConfigMap even when the
        // pre-write cluster read fails. Rollback used to omit it (deploy did not): in a
        // fresh CI checkout there is no local state.json to carry the generation forward,
        // so a post-cutover cluster outage stamped local generation 1 while the stale
        // cluster record sat at N — and readState prefers the higher generation, so the
        // next operation re-drained the build this rollback had just switched TO.
        basedOnGeneration: generation ?? null,
      },
      releaseName,
      namespace,
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
  const rbOutputDir = path.join(projectDir, ".k8s-adapter", outputDirName());
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
      namespace,
      "--ignore-not-found",
    ]);
    await execOrThrow("kubectl", [
      "scale",
      `deployment/${currentDeploy.name}`,
      "-n",
      namespace,
      "--replicas=0",
    ]);
  }

  console.log(`\n✓ Rollback complete. Now serving build: ${previousBuildId}`);
  console.log(`  To roll forward again: npx adapter-k8s rollback`);
  console.log(`  To deploy new code:    npx adapter-k8s deploy\n`);
}
