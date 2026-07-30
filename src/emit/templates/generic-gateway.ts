// src/emit/templates/generic-gateway.ts
//
// The Gateway for every provider that is not GKE.
//
// `gateway.ts` cannot be reused: it hardcodes `gatewayClassName: gke-l7-global-external-managed`
// and attaches a Google reserved IP by `NamedAddress`. On EKS/AKS/generic neither exists, and a
// Gateway referencing them simply never programs — it looks applied and serves nothing.
//
// TLS is deliberately different too. GKE resolves certificates through Certificate Manager via a
// `networking.gke.io/certmap` annotation; everywhere else a listener references a Kubernetes
// Secret (cert-manager on generic, and the cloud controllers on AKS/EKS can be pointed at their
// own certificate stores by annotation in later phases).
import { assertSafeReleaseName, assertSafeHostname } from "./utils.js";
import type { HostConfig } from "../../types.js";

export function renderGenericGateway({
  releaseName,
  gatewayClassName,
  hosts,
  tlsSecretName,
}: {
  releaseName: string;
  gatewayClassName: string;
  hosts: HostConfig[];
  /**
   * Secret holding the TLS cert/key for the HTTPS listener. Without it the HTTPS listener is
   * OMITTED rather than emitted certificate-less: a listener with no `certificateRefs` never
   * programs, so emitting one produces a Gateway that reports configured and then fails every
   * TLS request. Serving HTTP only is the honest degradation.
   */
  tlsSecretName?: string;
}): string {
  assertSafeReleaseName(releaseName);
  // Sanitized at the point of consumption, as gateway.ts does: hostnames are spliced into
  // double-quoted YAML scalars.
  for (const host of hosts) assertSafeHostname(host.hostname);
  // The class name reaches a YAML scalar; keep it to the Kubernetes name charset.
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(gatewayClassName)) {
    throw new Error(
      `Invalid gatewayClassName ${JSON.stringify(gatewayClassName)} — expected a lowercase ` +
        `Kubernetes resource name (e.g. "eg").`,
    );
  }

  // Reaches a bare YAML scalar, so it is charset-checked at the point of consumption — a
  // newline-bearing value would otherwise inject arbitrary chart YAML.
  if (tlsSecretName !== undefined && !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(tlsSecretName)) {
    throw new Error(
      `Invalid tlsSecretName ${JSON.stringify(tlsSecretName)} — expected a Kubernetes Secret name.`,
    );
  }

  const wantsTls = hosts.some((h) => h.tls?.enabled);
  const emitHttps = wantsTls && !!tlsSecretName;

  // ONE listener per protocol, named exactly `http` / `https`, with NO hostname.
  //
  // An earlier cut emitted a listener per host (`http-0`, `https-0`, …). That broke route
  // attachment silently: renderHTTPRoute binds with `sectionName: http` / `https`, so with
  // multiple hosts NO section matched, the route attached to nothing, and the Gateway still
  // reported programmed. Hostname matching belongs to the HTTPRoute, which already does it —
  // the same division GKE's gateway.ts uses.
  let listeners = `    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Same`;

  if (emitHttps) {
    listeners += `
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - kind: Secret
            name: ${tlsSecretName}
      allowedRoutes:
        namespaces:
          from: Same`;
  }

  return `apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: ${releaseName}-gateway
  labels:
    app.kubernetes.io/name: "${releaseName}"
spec:
  gatewayClassName: ${gatewayClassName}
  listeners:
${listeners}
`;
}
