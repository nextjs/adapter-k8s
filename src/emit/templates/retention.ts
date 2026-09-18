import { createHash } from "node:crypto";
import { assertSafeBuildId, assertSafeReleaseName, escapeHelmActions } from "./utils.js";
import {
  RETENTION_MAX_BYTES,
  inventorySignature,
  validateInventory,
  type BuildInventory,
} from "../../retention.js";

export function retentionName(release: string, buildId?: string) {
  assertSafeReleaseName(release);
  if (buildId !== undefined) assertSafeBuildId(buildId);
  return `${release.slice(0, 27)}-retention-${createHash("sha256")
    .update(`${release}\0${buildId === undefined ? "index" : `build\0${buildId}`}`)
    .digest("hex")
    .slice(0, 12)}`;
}
export function renderRetentionInventory(
  release: string,
  inventory: BuildInventory,
  secret: string,
) {
  validateInventory(inventory);
  const data = JSON.stringify(inventory);
  if (Buffer.byteLength(data) > RETENTION_MAX_BYTES / 4)
    throw new Error(
      "Retained build inventory exceeds 200KB; reduce assets/actions or disable retention",
    );
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${retentionName(release, inventory.buildId)}
  labels:
    app.kubernetes.io/name: ${release}
    app.kubernetes.io/component: retained-build-inventory
  annotations:
    helm.sh/resource-policy: keep
immutable: true
data:
  inventory.json: ${escapeHelmActions(JSON.stringify(data))}
  signature: ${JSON.stringify(inventorySignature(data, secret))}
`;
}
// The controller-owned index is optional on first deploy and is never reset by Helm.
export const retentionEnv = `            - name: ADAPTER_K8S_RETENTION_FILE
              value: /retention/index.json
`;
export const retentionMount = `            - name: retention
              mountPath: /retention
              readOnly: true
`;
export function retentionVolume(release: string) {
  return `        - name: retention
          configMap:
            name: ${retentionName(release)}
            optional: true
`;
}
