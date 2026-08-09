// src/emit/templates/routing-manifest-configmap.ts
import {
  sanitizeK8sName,
  routingManifestSnapshotName as routingManifestSnapshotNameLocal,
} from "./utils.js";
import { renderConfigMap } from "./configmap.js";

/**
 * The routing service (ext_proc edge) mounts its routing manifest from a STABLE ConfigMap
 * (`<release>-routing-manifest`) that every `helm upgrade` overwrites with the new build's
 * manifest, while the Deployment is updated in place to the new build's image. Rollback
 * therefore cannot just flip pool selectors — it must also revert the edge to the previous
 * build's image AND manifest. The previous manifest is not re-renderable at deploy/rollback
 * time (it came from that build's route classification), so the CLI retains a per-build
 * SNAPSHOT ConfigMap (`routingManifestSnapshotName`) copied from whatever the routing
 * Deployment was actually serving, before helm overwrites the stable one. These helpers
 * are the single source of truth for those names — the snapshot volume patch in rollback
 * must match byte-for-byte what the retention step applied.
 */

// Volume name in the routing-service Deployment template (routing-service-deployment.ts).
export const ROUTING_MANIFEST_VOLUME_NAME = "routing-manifest";
export const ROUTING_MANIFEST_SNAPSHOT_COMPONENT = "routing-manifest-snapshot";

/** The stable ConfigMap the chart renders and helm overwrites each deploy. */
export function routingManifestConfigMapName(releaseName: string): string {
  return `${releaseName}-routing-manifest`;
}

/**
 * The per-build retained copy, named after the build whose manifest it holds.
 * Implemented in utils.ts (re-exported here to keep this module the import path
 * deploy.ts/rollback.ts use) so the build-id collision guard can include snapshot
 * names without an import cycle. The name carries an 8-hex digest of the full
 * build id that always survives 63-char truncation — the old fixed
 * `-routing-manifest-` infix left ~5 build-id chars under a 40-char release, so
 * date-style build ids collided and rollback could mount the wrong manifest.
 */
export { routingManifestSnapshotName } from "./utils.js";

/** The stable, in-place-updated routing-service Deployment name. */
export function routingServiceDeploymentName(releaseName: string): string {
  return sanitizeK8sName(`${releaseName}-routing-service`);
}

/**
 * The PER-BUILD manifest ConfigMap the routing Deployment actually mounts. Rendered by the
 * chart itself (not just retained post-hoc by the CLI) so it exists atomically with the
 * Deployment update that references it. Mounting the stable mutable CM instead was a live
 * race: kubelet propagates UPDATES to watched ConfigMaps asynchronously (minutes, on a
 * degraded cluster), so a new routing pod could mount the pre-upgrade manifest and the
 * match guard crashed it — five consecutive GKE deploys died this way on 2026-07-30. A
 * never-seen NAME is a fresh GET with no propagation window, the same reason every other
 * per-build resource (pool Deployments, the N87 dispatch Secret) starts reliably.
 */
export function renderRoutingManifestSnapshotConfigMap({
  releaseName,
  buildId,
  routingManifestJson,
}: {
  releaseName: string;
  buildId: string;
  routingManifestJson: string;
}): string {
  assertManifestFitsConfigMap(routingManifestJson);
  const fullName = routingManifestSnapshotNameLocal(releaseName, buildId);
  // renderConfigMap prefixes the release name; the snapshot name already carries it.
  const suffix = fullName.slice(releaseName.length + 1);
  return renderConfigMap({
    name: suffix,
    releaseName,
    data: { "routing-manifest.json": routingManifestJson },
    labels: {
      "app.kubernetes.io/name": releaseName,
      "app.kubernetes.io/component": ROUTING_MANIFEST_SNAPSHOT_COMPONENT,
    },
    annotations: {
      // The previous routing ReplicaSet mounts this exact name during the next rollout and
      // rollback. Helm must retain it when the following chart stops rendering this build.
      "helm.sh/resource-policy": "keep",
    },
  });
}

// A ConfigMap (like any K8s object) must fit under the ~1 MiB etcd object limit.
// Fail fast at generation time with an actionable error rather than letting `helm
// install`/`kubectl apply` reject it with an opaque server-side error.
function assertManifestFitsConfigMap(routingManifestJson: string): void {
  const MAX_CONFIGMAP_BYTES = 950 * 1024; // ~950 KiB, leaves headroom under the ~1 MiB limit
  const routingManifestBytes = Buffer.byteLength(routingManifestJson, "utf8");
  if (routingManifestBytes > MAX_CONFIGMAP_BYTES) {
    throw new Error(
      `Routing manifest is too large to embed in a ConfigMap: ${routingManifestBytes} bytes ` +
        `exceeds the ${MAX_CONFIGMAP_BYTES}-byte limit (~950 KiB, under the ~1 MiB ` +
        `Kubernetes/etcd object size limit). Reduce the number of routes per manifest ` +
        `or split the app across multiple releases.`,
    );
  }
}

export function renderRoutingManifestConfigMap({
  releaseName,
  routingManifestJson,
}: {
  releaseName: string;
  routingManifestJson: string;
}): string {
  assertManifestFitsConfigMap(routingManifestJson);
  return renderConfigMap({
    name: "routing-manifest",
    releaseName,
    data: { "routing-manifest.json": routingManifestJson },
  });
}
