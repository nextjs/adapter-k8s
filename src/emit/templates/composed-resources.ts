import type { KubernetesManifest } from "../../composition-plan/types.js";
import { escapeHelmActions, sanitizeK8sName } from "./utils.js";
import { isNativePoolRoutingRoute, nativePoolRoutingVariant } from "../native-pool-routing.js";

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
      // Offline charts cannot prove a predecessor's pool Service has endpoints. Only
      // imperative deploy enables this after checking the live serving topology. Job
      // mode always uses the existing origin, even if a reused value requests direct.
      const rendered = isNativePoolRoutingRoute(manifest)
        ? `{{- if and (eq .Values.nativePoolRouting true) (ne .Values.cutover.mode "job") }}\n` +
          renderManifest(nativePoolRoutingVariant(manifest, true)) +
          `{{- else }}\n` +
          renderManifest(nativePoolRoutingVariant(manifest, false)) +
          `{{- end }}\n`
        : renderManifest(manifest);
      return [`templates/target-${ordinal}-${identity}.yaml`, rendered];
    }),
  );
}
