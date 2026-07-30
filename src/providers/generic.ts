// src/providers/generic.ts
//
// Any conformant Kubernetes cluster: K3s, kind, on-prem, or a managed cluster whose cloud
// integrations you would rather not adopt. The ext_proc callout is hosted by an in-cluster Envoy
// (Envoy Gateway) instead of a cloud load balancer.
//
// This is the ESCAPE HATCH the whole multi-provider plan hinges on, and it is also the shape
// AKS and EKS will use — neither AWS ALB nor Azure Application Gateway can call ext_proc, so on
// those clouds an in-cluster Envoy is not a fallback, it is the only option.
//
// PROVEN 2026-07-29 on k3s + Envoy Gateway v1.5.4 with the routing-service image unchanged:
// the full dispatch vocabulary reached the backend (`x-mw-evaluated: ran`), and scaling the
// routing service to zero returned 500 rather than bypassing middleware.
import { renderGenericGateway } from "../emit/templates/generic-gateway.js";
import { renderEnvoyExtensionPolicy } from "../emit/templates/envoy-extension-policy.js";
import { renderHTTPRoute, httpRouteName } from "../emit/templates/gateway.js";
import { RELEASE_NAMESPACE_EXPR } from "../emit/templates/network-policy.js";
import { genericConfigOf } from "../types.js";
import type { ProviderAdapter, ProviderChartContext, ProviderExtProcContext } from "./types.js";

/** Envoy Gateway's default GatewayClass. */
const DEFAULT_GATEWAY_CLASS = "eg";

export const genericProvider: ProviderAdapter = {
  name: "generic",
  extProcStrategy: "envoy-gateway",

  emitIngressTemplates({ releaseName, pools, routingManifest, config }: ProviderChartContext) {
    const files: Record<string, string> = {};
    const generic = genericConfigOf(config);
    const hosts = generic?.gateway?.hosts ?? [];
    if (!hosts.length) return files;

    files["templates/gateway.yaml"] = renderGenericGateway({
      releaseName,
      gatewayClassName: generic?.gateway?.className ?? DEFAULT_GATEWAY_CLASS,
      hosts,
      ...(generic?.gateway?.tlsSecretName ? { tlsSecretName: generic.gateway.tlsSecretName } : {}),
    });

    // The HTTPRoute is provider-independent: it maps pathnames to pool Services, which is the
    // same on every platform. No CDN filter — Cloud CDN is a GKE concept, and a generic cluster
    // puts whatever CDN it likes in FRONT of the gateway rather than inside the route.
    //
    // TLS: a route binding `sectionName: https` with no HTTPS listener attaches to nothing and
    // serves nothing, while every resource still reports healthy. An earlier cut silently
    // DEGRADED to HTTP here; that is worse than refusing, because it ships plaintext for a
    // config that explicitly asked for TLS. validateConfig rejects this for the adapter path, but a direct generateHelmChart caller
    // bypasses that — and silently emitting an HTTP-only app for a config that asked for TLS is
    // the worst outcome available: it deploys, reports healthy, and serves credentials in the
    // clear. Refuse at the point of consumption as well.
    if (hosts.some((h) => h.tls?.enabled) && !generic?.gateway?.tlsSecretName) {
      throw new Error(
        `provider.generic.gateway.tlsSecretName is required when any host sets tls.enabled: ` +
          `true — a Gateway listener with no certificateRef never programs, so the alternative ` +
          `is serving plaintext while reporting success.`,
      );
    }
    files["templates/http-route.yaml"] = renderHTTPRoute({
      releaseName,
      hosts,
      pools,
      routingManifest,
    });

    return files;
  },

  // The whole reason this provider is cheap to operate: no registration Job, no cloud IAM, no
  // Workload Identity, no impersonation surface. One namespaced resource.
  emitExtProcTemplates({
    releaseName,
    config,
    routingFailOpen,
    requestTimeoutMs,
  }: ProviderExtProcContext) {
    const generic = genericConfigOf(config);
    if (!generic?.gateway?.hosts?.length) return {};
    return {
      "templates/envoy-extension-policy.yaml": renderEnvoyExtensionPolicy({
        releaseName,
        // Mirror the routing server's own policy: the filter and the server must not disagree
        // about whether a failed callout blocks the request.
        ...(routingFailOpen !== undefined ? { failOpen: routingFailOpen } : {}),
        ...(requestTimeoutMs !== undefined ? { messageTimeoutMs: requestTimeoutMs } : {}),
        // Attaches to the HTTPRoute emitted above, so the callout covers exactly the traffic
        // this release serves rather than everything the shared Gateway carries. The name comes
        // from the emitter — a hand-written copy drifted once already and failed silently.
        routeName: httpRouteName(releaseName),
      }),
    };
  },

  // `cloud.google.com/neg` is meaningless here: an in-cluster gateway routes to the Service.
  routingServiceAnnotations() {
    return {};
  },

  // No such CRD outside GKE — emitting it fails the whole install.
  emitsHealthCheckPolicyCrd: false,

  // Envoy Gateway dials the ext_proc backend as plain h2c. Safe only because the emitted
  // NetworkPolicy admits :8443 solely from this release's own proxy pods — the ext_proc reply
  // carries INTERNAL_HEADER_SECRET, so reachability to this port IS the credential.
  routingTransport: "h2c",

  // No Google CIDRs. The gateway runs IN the cluster, so the dataplane is reachable by workload
  // identity rather than a guess at someone else's published IP ranges — strictly better than
  // the allowlist GKE is stuck with.
  //
  // The labels are VERIFIED against a running Envoy Gateway v1.5.4 proxy, not taken from docs.
  // An earlier cut selected `app.kubernetes.io/name: envoy-gateway`, which is the CONTROLLER
  // deployment — the data-plane pods carry `app.kubernetes.io/name: envoy` plus
  // `gateway.envoyproxy.io/owning-gateway-{name,namespace}`. Selecting the controller would
  // have denied every real request while admitting the one workload that never sends any.
  //
  // Scoped to THIS release's Gateway by name, so a second release's proxies in the same
  // cluster cannot reach this routing service — and reachability to :8443 IS the internal
  // dispatch secret, since the ext_proc reply carries it.
  strictIngressSources({ releaseName, config }: ProviderChartContext) {
    const generic = genericConfigOf(config);
    return {
      cidrs: [],
      podSelectors: [
        {
          // Envoy Gateway runs proxies in its own namespace, not the app's.
          namespace: generic?.gatewayNamespace ?? "envoy-gateway-system",
          labels: {
            "app.kubernetes.io/name": "envoy",
            "gateway.envoyproxy.io/owning-gateway-name": `${releaseName}-gateway`,
            // BOTH halves of the owning-gateway identity are required. With the name alone, a
            // Gateway of the SAME name in a different application namespace produces proxy pods
            // carrying matching labels in the shared proxy namespace — so another tenant's
            // proxies would be admitted to this release's ext_proc port, and reachability to
            // that port IS the internal dispatch secret. The value is resolved by helm because
            // only helm knows which namespace the release installs into.
            "gateway.envoyproxy.io/owning-gateway-namespace": RELEASE_NAMESPACE_EXPR,
          },
        },
        {
          // MERGED proxies (EnvoyProxy `mergeGateways` — how Phase-2 lanes share one data
          // plane) are owned by the GatewayCLASS: their pods carry ONLY
          // `owning-gatewayclass: <class>`, never the per-gateway pair above, so without this
          // peer a netpol-enforcing CNI refuses every proxy→pool and proxy→ext_proc
          // connection (measured on k3d: pods Ready, Envoy connection-refused, fail-closed
          // 500s). TENANCY TRADE, stated plainly: the merged proxy serves every release on
          // the class, so admitting it admits the SHARED data plane to this release's
          // ext_proc port — reachability-as-secret narrows to "the class's data plane".
          // That is inherent to choosing merged gateways; per-release proxy identity does
          // not exist there. Non-merged deployments are unaffected: peers are OR'd and their
          // proxies match the stricter peer above.
          namespace: generic?.gatewayNamespace ?? "envoy-gateway-system",
          labels: {
            "app.kubernetes.io/name": "envoy",
            "gateway.envoyproxy.io/owning-gatewayclass":
              generic?.gateway?.className ?? "eg",
          },
        },
      ],
    };
  },
};
