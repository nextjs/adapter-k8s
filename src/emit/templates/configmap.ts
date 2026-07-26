// src/emit/templates/configmap.ts
import { assertSafeReleaseName, escapeHelmActions, sanitizeK8sName } from "./utils.js";

// ConfigMap data keys must match [-._a-zA-Z0-9]+ (the API server enforces it) — and the
// key is emitted as a BARE YAML scalar before the `|` block indicator, so anything outside
// that charset is also a YAML-injection sink.
const CONFIGMAP_KEY_RE = /^[-._a-zA-Z0-9]+$/;

export function renderConfigMap({
  name,
  releaseName,
  data,
}: {
  name: string;
  releaseName: string;
  data: Record<string, string>;
}): string {
  // Sanitize at the point of consumption (AGENTS.md) — nothing here was checked.
  assertSafeReleaseName(releaseName);
  const safeName = sanitizeK8sName(`${releaseName}-${name}`);
  const dataEntries = Object.entries(data)
    .map(([key, value]) => {
      if (!CONFIGMAP_KEY_RE.test(key)) {
        throw new Error(
          `Invalid ConfigMap data key "${key}": must match ${CONFIGMAP_KEY_RE}. The key is ` +
            `emitted as a bare YAML scalar, so it cannot be escaped.`,
        );
      }
      // A block scalar (`|`) carries an arbitrary value safely as long as every line is
      // indented past the key — the split/map below guarantees that. It does NOT make the
      // value inert to HELM, though: this file lands under `templates/`, so Go template
      // actions inside it are executed before the YAML is ever parsed (S5).
      return `  ${key}: |\n${escapeHelmActions(value)
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n")}`;
    })
    .join("\n");
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${safeName}
data:
${dataEntries}
`;
}
