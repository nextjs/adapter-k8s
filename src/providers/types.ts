// src/providers/types.ts
//
// The provider seam. `provider: { gke: … }` was the only shape this adapter emitted for, and
// every cloud-specific decision was inlined at its use site. AKS/EKS/generic need those same
// decisions answered differently, so they move behind an interface here.
//
// Phase 0 of plans/multi-provider-aks-eks-generic.md is a REFACTOR: the emitted chart must stay
// byte-identical. Nothing in this file may change what GKE renders.
import type { K8sAdapterConfig, PoolDefinition, RoutingManifest } from "../types.js";

/**
 * How the ext_proc callout gets registered with the data plane.
 *
 * Only two exist, and that is a fact about the clouds rather than a simplification: neither AWS
 * ALB nor Azure Application Gateway supports ext_proc at all, so EKS/AKS/generic all need an
 * in-cluster Envoy either way. MEASURED 2026-07-29 on k3s + Envoy Gateway v1.5.4 — an
 * `EnvoyExtensionPolicy` carries our full dispatch vocabulary (`x-output-id`,
 * `x-internal-secret`, `x-mw-evaluated: ran`) with the routing-service image unchanged, and
 * `failOpen: false` fails closed. See the prototype section of the plan.
 */
export type ExtProcStrategy = "gke-traffic-extension" | "envoy-gateway";

export type ProviderName = "gke" | "eks" | "aks" | "generic";

/** Everything a provider needs to emit its ingress-tier templates. */
export interface ProviderChartContext {
  releaseName: string;
  pools: Map<string, PoolDefinition>;
  routingManifest: RoutingManifest;
  config: K8sAdapterConfig;
}

/** Context for the ext_proc wiring, which needs the pool set and the routing tier's name. */
export interface ProviderExtProcContext extends ProviderChartContext {
  buildId: string;
  /** GKE only: the traffic-extension registration Job needs project/region to call gcloud. */
  infrastructure?: { projectId?: string; region?: string } | undefined;
  extensionChainJson?: string | undefined;
  routeExtDocumentDigest: () => string;
  /**
   * Callout failure policy and budget, so the DATA PLANE agrees with the routing server.
   * These already reach the routing Deployment (ROUTING_FAIL_OPEN / ROUTING_REQUEST_TIMEOUT_MS);
   * without them here an `envoy-gateway` provider would hardcode fail-closed at 4s while the
   * server was configured open — two different verdicts for the same request.
   */
  routingFailOpen?: boolean | undefined;
  requestTimeoutMs?: number | undefined;
}

export interface ProviderAdapter {
  readonly name: ProviderName;
  readonly extProcStrategy: ExtProcStrategy;

  /**
   * Ingress-tier chart files: the Gateway, its route, and any CDN attachment. Returns the
   * `templates/<name>.yaml` → contents map to merge into the chart, so a provider with no
   * gateway configured contributes nothing rather than being special-cased by the caller.
   */
  emitIngressTemplates(ctx: ProviderChartContext): Record<string, string>;

  /**
   * How the ext_proc callout gets attached to the data plane. On GKE this is a privileged
   * registration Job plus its ServiceAccount and config; on `envoy-gateway` providers it is an
   * `EnvoyExtensionPolicy`, which needs no cloud IAM at all — that difference is the single
   * biggest reason this seam exists.
   */
  emitExtProcTemplates(ctx: ProviderExtProcContext): Record<string, string>;

  /**
   * Provider-specific annotations on the ROUTING tier's Service. GKE needs
   * `cloud.google.com/neg` so the GXLB can target pods directly; an in-cluster gateway needs
   * nothing, and emitting a Google annotation there is inert noise at best.
   */
  routingServiceAnnotations(ctx: ProviderChartContext): Record<string, string>;

  /**
   * Whether the platform configures load-balancer health checks through an in-cluster CRD
   * (`networking.gke.io/v1 HealthCheckPolicy`). GKE does; nobody else has that API, and a chart
   * containing an unknown API group is rejected WHOLE — one stray document fails the entire
   * install rather than degrading.
   */
  readonly emitsHealthCheckPolicyCrd: boolean;

  /**
   * Transport the ext_proc listener must serve for THIS platform's callout. GKE's arrives over
   * TLS from Google's frontend; an in-cluster Envoy Gateway dials h2c.
   */
  readonly routingTransport: "tls" | "h2c";

  /**
   * Ingress sources allowed to reach the dataplane under the STRICT NetworkPolicy posture.
   * GKE returns Google load-balancer CIDRs; an in-cluster gateway returns a podSelector for the
   * gateway's own pods — which is strictly better, since it is workload identity rather than a
   * guess at someone else's IP ranges.
   */
  strictIngressSources(ctx: ProviderChartContext): {
    cidrs: string[];
    podSelectors: Array<{ namespace?: string; labels: Record<string, string> }>;
  };
}
