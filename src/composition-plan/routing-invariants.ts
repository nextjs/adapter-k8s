import type { ClusterIdentity, KubernetesManifest, RoutingPlan } from "./types.js";

export function assertGcpTrafficExtensionTopology({
  identity,
  routing,
  objects,
  subject = "Routing plan",
}: {
  identity: ClusterIdentity;
  routing: RoutingPlan;
  objects: readonly KubernetesManifest[];
  subject?: string;
}): void {
  const registration = routing.registration;
  if (registration?.kind !== "gcp-traffic-extension-v1") return;

  const matchingReadiness = routing.dataplane.readiness.some(
    (entry) =>
      entry.kind === "gcp-traffic-extension" &&
      entry.projectId === registration.projectId &&
      entry.extensionName === registration.extensionName &&
      entry.addressName === registration.addressName,
  );
  if (!matchingReadiness) {
    throw new Error(
      `${subject} must declare readiness matching its gcp-traffic-extension-v1 registration`,
    );
  }

  if (identity.kind === "gke-resource" && identity.projectId !== registration.projectId) {
    throw new Error(
      `${subject} uses GCP project ${JSON.stringify(registration.projectId)}, but the GKE ` +
        `cluster and its controller-owned Gateway resources are in ` +
        `${JSON.stringify(identity.projectId)}. Cross-project GKE traffic-extension ` +
        `registration is not supported.`,
    );
  }

  let addressMatches = 0;
  for (const object of objects) {
    if (object.kind !== "Gateway") continue;
    const spec = object.body?.spec;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
    const addresses = spec.addresses;
    if (!Array.isArray(addresses)) continue;
    for (const address of addresses) {
      if (
        address &&
        typeof address === "object" &&
        !Array.isArray(address) &&
        address.type === "NamedAddress" &&
        address.value === registration.addressName
      ) {
        addressMatches += 1;
      }
    }
  }
  if (addressMatches !== 1) {
    throw new Error(
      `${subject} requires exactly one Gateway NamedAddress ` +
        `${JSON.stringify(registration.addressName)}, but the resource plan declared ` +
        `${addressMatches}. Pass addresses: [{ type: "NamedAddress", value: ` +
        `${JSON.stringify(registration.addressName)} }] to gatewayApiExposure().`,
    );
  }
}
