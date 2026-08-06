import type { KubernetesManifest } from "../../composition-plan/types.js";
import { escapeHelmActions, sanitizeK8sName } from "./utils.js";

function renderManifest(manifest: KubernetesManifest): string {
  const document = {
    apiVersion: manifest.apiVersion,
    kind: manifest.kind,
    metadata: manifest.metadata,
    ...manifest.body,
  };
  return escapeHelmActions(JSON.stringify(document, null, 2)) + "\n";
}

/** Render validated build-time contributions as deterministic Helm templates. */
export function renderComposedResources(
  manifests: readonly KubernetesManifest[],
): Record<string, string> {
  return Object.fromEntries(
    manifests.map((manifest, index) => {
      const ordinal = String(index).padStart(3, "0");
      const identity = sanitizeK8sName(`${manifest.kind.toLowerCase()}-${manifest.metadata.name}`);
      return [`templates/target-${ordinal}-${identity}.yaml`, renderManifest(manifest)];
    }),
  );
}
