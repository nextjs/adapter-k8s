// src/providers/gke.ts
//
// GKE: the original and, for now, the only provider with a NATIVE ext_proc mechanism. The GXLB
// traffic extension is a managed callout on Google's global load balancer, which is why GKE
// keeps it rather than moving to an in-cluster Envoy — that swap would trade a managed global LB
// and Cloud CDN (with the cache-tag invalidation contract built on it) for a hop we operate.
//
// It is also a CONSTRAINT, not just a preference: MEASURED 2026-07-29, installing Envoy Gateway
// on GKE Autopilot fails outright. GKE manages the Gateway API CRDs and a
// ValidatingAdmissionPolicy (`enforce-gateway-standard-channel`) denies Envoy Gateway's
// experimental-channel CRDs, with further conflicts against kube-addon-manager on the shared
// `httproutes` CRD.
//
// Phase 0 is a refactor: this file must emit byte-identical output to the inline block it
// replaced in helm.ts.
import { renderGateway, renderHTTPRoute } from "../emit/templates/gateway.js";
import { renderCdnFilter } from "../emit/templates/gcp-http-filter.js";
import { sanitizeK8sName } from "../emit/templates/utils.js";
import { renderRouteExtUpdateJob } from "../emit/templates/route-ext-update-job.js";
import { renderRouteExtConfigMap } from "../emit/templates/route-ext-configmap.js";
import { renderDeployServiceAccount } from "../emit/templates/deploy-service-account.js";
import { STRICT_INGRESS_CIDRS } from "../emit/templates/network-policy.js";
import { gkeConfigOf } from "../types.js";
import type { ProviderAdapter, ProviderChartContext, ProviderExtProcContext } from "./types.js";

export const gkeProvider: ProviderAdapter = {
  name: "gke",
  extProcStrategy: "gke-traffic-extension",

  emitIngressTemplates({ releaseName, pools, routingManifest, config }: ProviderChartContext) {
    const files: Record<string, string> = {};
    const gke = gkeConfigOf(config);
    if (!gke?.gateway?.hosts?.length) return files;

    files["templates/gateway.yaml"] = renderGateway({
      releaseName,
      hosts: gke.gateway.hosts,
    });

    // Cloud CDN rides the HTTPRoute (GCPHTTPFilter via ExtensionRef), so it only exists
    // when a gateway does. validateConfig guarantees hosts for adapter-built configs;
    // the double condition covers direct generateHelmChart callers.
    let cdnFilterName: string | undefined;
    if (gke.cdn?.enabled) {
      cdnFilterName = sanitizeK8sName(`${releaseName}-cdn`);
      files["templates/cdn-http-filter.yaml"] = renderCdnFilter({
        releaseName,
        cacheMode: gke.cdn.cacheMode,
        cacheKeyHeaders: gke.cdn.cacheKeyHeaders,
      });
    }

    files["templates/http-route.yaml"] = renderHTTPRoute({
      releaseName,
      hosts: gke.gateway.hosts,
      pools,
      routingManifest,
      ...(cdnFilterName ? { cdnFilterName } : {}),
    });

    return files;
  },

  // The GXLB traffic extension is registered by a Job that calls gcloud with a
  // Workload-Identity-bound ServiceAccount. That Job — and the project-scoped IAM behind it —
  // is exactly what an `envoy-gateway` provider does NOT need: an EnvoyExtensionPolicy is a
  // plain Kubernetes resource.
  emitExtProcTemplates({
    releaseName,
    buildId,
    infrastructure,
    extensionChainJson,
    routeExtDocumentDigest,
  }: ProviderExtProcContext) {
    if (!extensionChainJson) return {};
    // N50: without projectId/region the chain JSON renders
    // `projects//global/backendServices/...` and nothing can register it — the chart would
    // install the routing service while the edge silently kept the previous build's chain (or
    // bypassed the middleware tier) and the deploy reported success. Refuse instead.
    const missing = [
      infrastructure?.projectId ? null : "projectId",
      infrastructure?.region ? null : "region",
    ].filter((m): m is string => m !== null);
    if (missing.length > 0) {
      throw new Error(
        `[adapter-k8s] Cannot render the GXLB traffic extension: .k8s-adapter/` +
          `infrastructure.json is missing ${missing.join(" and ")}. Without ${missing.join(" and ")} ` +
          `the chart would install the ext_proc routing service but never register the route ` +
          `extension — the edge would keep the previous build's chain (or bypass the middleware ` +
          `tier entirely) while the deploy reported success. Run \`npx adapter-k8s init\` to ` +
          `regenerate infrastructure.json.`,
      );
    }

    const files: Record<string, string> = {};
    files["templates/route-ext-config.yaml"] = renderRouteExtConfigMap({
      releaseName,
      // Guaranteed non-empty by generateHelmChart's `if (extensionChainJson)` guard.
      extensionChainJson: extensionChainJson!,
    });
    // Guaranteed present by generateHelmChart's guard.
    files["templates/route-ext-update-job.yaml"] = renderRouteExtUpdateJob({
      releaseName,
      projectId: infrastructure!.projectId!,
      region: infrastructure!.region!,
      buildId,
      // S9: pin the Job to the exact document the ConfigMap above rendered.
      documentDigest: routeExtDocumentDigest(),
    });
    files["templates/deploy-service-account.yaml"] = renderDeployServiceAccount({
      releaseName,
      projectId: infrastructure!.projectId!,
    });
    return files;
  },

  // The GXLB targets pod IPs directly through a standalone NEG, so the routing Service must
  // declare one. In-cluster gateways route to the Service normally and need nothing here.
  routingServiceAnnotations({ releaseName }: ProviderChartContext) {
    return {
      "cloud.google.com/neg": `{"exposed_ports":{"8443":{"name":"${releaseName}-routing-neg"}}}`,
    };
  },

  // GXLB health checks are configured by the HealthCheckPolicy CRD.
  emitsHealthCheckPolicyCrd: true,

  // The GXLB callout arrives from Google's frontend and requires HTTP/2 over TLS.
  routingTransport: "tls",

  // Google's published GFE proxy + health-check ranges. The README is explicit that this
  // trusts those ranges wholesale — a network control cannot tell your load balancer's traffic
  // from anything else sourced from them. An in-cluster gateway replaces this with a
  // podSelector, which is real workload identity.
  strictIngressSources() {
    return { cidrs: [...STRICT_INGRESS_CIDRS], podSelectors: [] };
  },
};
