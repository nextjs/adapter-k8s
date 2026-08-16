// src/emit/templates/network-policy.ts
import { assertSafePoolName, assertSafeReleaseName, sanitizeK8sName } from "./utils.js";

// Default-deny-by-allowlist NetworkPolicies for the two workload tiers, gated on the
// deploy CLI discovering the cluster's pod CIDRs (`--set global.networkPolicy.podCidrs=
// {...}`). The whole file is wrapped in a helm `if` so an empty list renders nothing
// (no policies) rather than a broken document.
//
// TWO POSTURES, selected by `global.networkPolicy.strict` (default: false = the broad
// posture below, unchanged):
//
// BROAD (default). Both tiers allow ingress from 0.0.0.0/0 EXCEPT the pod CIDRs: the
// external LB and Google health-check probes arrive with non-pod source IPs, while
// in-cluster pods are blocked from talking to these ports directly. That
// `ipBlock.cidr: 0.0.0.0/0` + `except: <pod CIDR>` shape is Google's own documented
// recipe for "broad range without Pod traffic" under **Calico** — with Calico, ipBlock
// rules DO cover pod traffic, so the pod range must be subtracted explicitly. Under
// GKE Dataplane V2 (Autopilot's default) the subtraction is a no-op: "Pod traffic is
// never covered by an ipBlock rule … even if you define a broad rule such as
// cidr: '0.0.0.0/0'". Keeping the `except` therefore costs nothing on Dataplane V2 and
// is load-bearing on Calico Standard clusters — do not remove it.
//   https://docs.cloud.google.com/kubernetes-engine/docs/how-to/network-policy
//     (#ipblock_behavior_in_calico / #ipblock_behavior_in_gke_dataplane_v2)
//
// STRICT (opt-in). Replaces the 0.0.0.0/0 denylist with a positive allowlist of the
// Google-owned load-balancer ranges — see N19 below for the grounding, the residual
// risk, and why it is not the default.
//
// Pool pods additionally allow ingress from SIBLING POOL pods only — cross-pool proxy
// traffic (pool-server/dispatch.ts proxyToPool) is pool-to-pool; the routing service
// never calls pools, so its `routing-service` component is deliberately NOT in the
// podSelector union. Any pool may proxy to any other pool of the release, so every pool
// component is listed. That rule is a podSelector (not an ipBlock) in BOTH postures,
// which is also what Google requires: "always select Pods by their namespace or Pod
// labels … Don't use the ipBlock.cidr field to intentionally select Pod IP address
// ranges, which are ephemeral in nature."
//
// Neither posture governs EGRESS (`policyTypes: [Ingress]` only), so pool → Memorystore
// (Valkey), pool → GCS / Artifact Registry, pool → kube-system DNS, and the routing
// service's outbound calls are all unrestricted by these policies and unaffected by the
// strict flag. Adding egress rules would be a separate, much riskier change (the
// metadata-server and DNS carve-outs GKE requires are version-dependent).

// N19 (SECURITY). Grounding for the strict allowlist. The security review that flagged
// "ingress from 0.0.0.0/0 is too permissive" was deferred with the reason "no grounding
// for the exact GFE ranges"; this is that grounding, from Google's docs plus the live
// topology. The strict posture is opt-in, not default — see WHY NOT DEFAULT.
//
// TOPOLOGY THIS ADAPTER EMITS. A GKE Gateway of class `gke-l7-global-external-managed`
// (gateway.ts) — i.e. a **global external Application Load Balancer**, GFE-based, not
// Envoy/proxy-only-subnet based — with **container-native load balancing**: pool
// Services and the routing Service are backed by zonal NEGs with `GCE_VM_IP_PORT`
// endpoints (routing-service-service.ts pins its own standalone NEG explicitly), so the
// GFE connects to the POD IP directly and the pod sees the GFE's own source address.
// There is no node-port hop and no SNAT to a node IP, and no proxy-only subnet is
// involved. Verified on the live cluster: both NEGs report ENDPOINT_TYPE
// GCE_VM_IP_PORT, and the routing callout's backend service is
// loadBalancingScheme EXTERNAL_MANAGED / protocol HTTP2 over that NEG.
//
// RANGES (docs.cloud.google.com, "Firewall rules | Cloud Load Balancing", table row
// "Global external Application Load Balancer"):
//   https://docs.cloud.google.com/load-balancing/docs/firewall-rules
//   - GFE proxy ranges, verbatim: "The following are the proxy ranges if the backends
//     are instance groups, zonal NEGs (GCE_VM_IP_PORT), or hybrid connectivity NEGs
//     (NON_GCP_PRIVATE_IP_PORT)." — IPv4: 35.191.0.0/16, 130.211.0.0/22;
//     IPv6: 2600:2d00:1:1::/64.
//   - Health check ranges: IPv4 35.191.0.0/16; IPv6 2600:2d00:1:b029::/64. (The
//     external-ALB firewall page also lists 130.211.0.0/22 for health checks; it is a
//     GFE proxy range regardless, so the union is the same either way.)
//     https://docs.cloud.google.com/load-balancing/docs/https#firewall_rules
//   - "Health checks overview" confirms the GFE-based-LB probe ranges for zonal NEG
//     backends: IPv4 35.191.0.0/16, IPv6 2600:2d00:1:b029::/64.
//     https://docs.cloud.google.com/load-balancing/docs/health-check-concepts
//   Corroborated by GKE itself: the Gateway controller auto-creates the VPC firewall
//   rule `gkegw1-<hash>-l7-<network>-global` with sourceRanges
//   130.211.0.0/22,35.191.0.0/16 and tcp:0-65535 to the node tag. On the live cluster
//   that rule is the ONLY one admitting those ranges — the ext_proc callout to
//   :8443 works today, which empirically pins the callout's source to the same GFE
//   ranges (Service Extensions docs only say callout servers "might need firewall rules
//   to allow proxy traffic" and defer to the firewall-rules page above:
//   https://docs.cloud.google.com/service-extensions/docs/configure-callout-backend-service).
//
// STABILITY CAVEAT — this is why the ranges are a floor, not a fence. Health checks
// overview, verbatim: "The probe IP ranges are a complete set of possible IP addresses
// used by Google Cloud probers… As a best practice, create ingress firewall rules that
// allow all of the probe IP ranges as sources. Google Cloud can implement new probers
// automatically without notification." So Google reserves the right to probe from
// addresses inside these ranges without notice; the published ranges themselves carry
// no stability guarantee. Two consequences: (1) allow ALL the listed ranges, never a
// subset — "If your firewall rule allows packets from only a subset of the ranges, you
// might see health check failures"; (2) a future Google range addition would break a
// strict policy silently (unhealthy backends), which is a real operational cost of
// opting in. The same page is why the allowlist is meaningful rather than cosmetic:
// "Google edge routers drop packets from the internet if the packets spoof source IP
// addresses from a probe IP range", and "You can't use the probe IP ranges for subnets
// in your VPC networks" — nothing an attacker controls can source from these ranges.
//
// AUTOPILOT / DATAPLANE V2. Autopilot always enforces NetworkPolicy and always uses
// GKE Dataplane V2 ("the recommended network plugin for all clusters and … default for
// Autopilot clusters"), where ipBlock never matches pod traffic; Standard clusters
// created with --enable-network-policy (init.ts) get Calico, where it does. The ranges
// above are load-balancer facts and identical on both. The strict allowlist is the
// posture that behaves the SAME on both implementations: it never names the pod range
// at all, so it does not depend on `podCidrs` discovery being correct or complete.
//
// S22 — NOW THE DEFAULT. `deploy` discovers the node range (discoverClusterNodeCidrs:
// cluster subnetwork -> its primary range, VERIFIED live: nodes 10.128.15.x inside
// 10.128.0.0/20), so the requirement below no longer costs the operator anything. The
// broad posture never bounded the dispatch credential: it isolates in-cluster PODS only,
// while any VPC peer could reach :8443. (v1 read a replayable x-internal-secret out of the
// ext_proc header mutation; since the dispatch-proof change the reply carries only a
// per-request HMAC proof, so this is defense-in-depth, not the trust boundary.) Kept below
// for why nodeCidrs is REQUIRED whenever strict is on — the kubelet. `nodeCidrs` is REQUIRED when strict is on, and the
// template `fail`s without it, because the broad posture is silently also allowing
// something the LB ranges do not cover: kubelet's liveness/readiness probes
// (deployment.ts probes :3000, routing-service-deployment.ts probes :8081) originate
// from the NODE's IP, which is in the cluster subnet — outside the pod CIDR, hence
// permitted by `0.0.0.0/0 except <pod CIDR>` today. Under Calico, host→pod traffic IS
// subject to ingress policy, so an LB-only allowlist leaves every pod permanently
// unready (Dataplane V2/Cilium exempts the local host, but we do not want the emitted
// policy to depend on which dataplane is in play). Failing at render time is strictly
// better than discovering it at rollout: blue/green only cuts over after /healthz
// verification (invariant 3), so the mistake would cost a deploy rather than an outage,
// but it should cost neither.
//
// WHAT STRICT DOES NOT NARROW (deliberately left broad — no documented basis to narrow):
//   - The node range itself. It is operator-supplied and typically the whole cluster
//     subnet, so any VM in that subnet keeps its current reach. Narrower than today's
//     whole-VPC-plus-peers exposure, but not a Google-documented value we can derive.
//   - Egress: ungoverned in both postures (see above).
//   - hostNetwork pods: "Neither GKE Dataplane V2 nor Calico enforce network policies
//     for Pods that use the spec.hostNetwork: true setting" — such a pod bypasses the
//     policy entirely in either posture.
//   - The fail-safe layering that makes the residual exposure survivable is unchanged:
//     a request arriving without trusted dispatch headers gets full local resolution
//     (middleware runs), and dispatch headers are honored only with the shared secret.

/**
 * GFE proxy source ranges for a global external Application Load Balancer whose
 * backends are zonal NEGs (`GCE_VM_IP_PORT`) — i.e. every backend this chart creates.
 * Pinned by tests; widening this list is a security change (see N19).
 */
export const GFE_PROXY_CIDRS = ["35.191.0.0/16", "130.211.0.0/22", "2600:2d00:1:1::/64"] as const;

/**
 * Health-check prober source ranges for GFE-based load balancers with zonal NEG
 * backends (both the Gateway's pool health checks and the `<release>-routing-hc` TCP
 * check on :8443 that init.ts creates). Pinned by tests (see N19).
 */
export const HEALTH_CHECK_PROBE_CIDRS = ["35.191.0.0/16", "2600:2d00:1:b029::/64"] as const;

/**
 * The union actually emitted in the strict posture, de-duplicated and in a stable order:
 * GFE proxy ranges first, then the probe-only range. IPv6 entries are inert on
 * single-stack IPv4 clusters (no pod has an address a v6 source could reach) and are
 * what makes a dual-stack cluster work without a second knob.
 */
export const STRICT_INGRESS_CIDRS: readonly string[] = [
  ...GFE_PROXY_CIDRS,
  ...HEALTH_CHECK_PROBE_CIDRS.filter((c) => !(GFE_PROXY_CIDRS as readonly string[]).includes(c)),
];

/**
 * The ONE helm expression permitted as a selector label value.
 *
 * A provider sometimes needs the release's own namespace in a selector — Envoy Gateway labels
 * its proxies with `owning-gateway-namespace`, and only helm knows where the release installs.
 * Every other value is charset-checked, so this is an explicit single-item allowlist rather than
 * a hole: permitting arbitrary `{{ … }}` would let a config-supplied value inject template
 * directives into the rendered chart.
 */
export const RELEASE_NAMESPACE_EXPR = "{{ .Release.Namespace }}";

export function renderNetworkPolicies({
  releaseName,
  poolNames,
  ingressSources,
}: {
  releaseName: string;
  poolNames: string[];
  /**
   * The STRICT posture's admitted sources, from the provider.
   *
   * GKE can only name Google's published GFE/health-check CIDRs — a network control cannot
   * tell your load balancer's traffic from anything else sourced from those ranges, which the
   * README states plainly. A provider whose gateway runs IN the cluster supplies a podSelector
   * instead: real workload identity, scoped to that release's own proxies.
   *
   * This matters more than it looks: the ext_proc reply carries INTERNAL_HEADER_SECRET, so
   * whatever can reach :8443 can obtain the credential that makes a pool trust dispatch
   * headers. Defaults to GKE's CIDRs so existing callers are unchanged.
   */
  ingressSources?: {
    cidrs: readonly string[];
    podSelectors: ReadonlyArray<{ namespace?: string; labels: Record<string, string> }>;
  };
}): string {
  assertSafeReleaseName(releaseName);
  // N61. Pool names reach LABEL VALUES and label SELECTORS below; they are quoted at every
  // interpolation (an unquoted "on"/"no"/"true" renders a YAML boolean the apiserver
  // refuses to unmarshal into map[string]string) and charset-checked here.
  for (const poolName of poolNames) assertSafePoolName(poolName);

  // The CIDR list is only ever expanded by helm from values the deploy CLI sets; keep
  // the `range` at column 0 so the rendered `- "cidr"` lines indent under `except:`.
  const broadFrom = `        - ipBlock:
            cidr: 0.0.0.0/0
            except:
{{- range .Values.global.networkPolicy.podCidrs }}
              - {{ . | quote }}
{{- end }}`;

  // Literal, doc-grounded constants (N19) — not helm values, so no deploy-time knob can
  // widen them; they change only with a code review of this file.
  const sources = ingressSources ?? { cidrs: STRICT_INGRESS_CIDRS, podSelectors: [] };
  // Charset-check anything reaching a selector: these become label keys/values and a
  // namespace name in rendered YAML.
  for (const sel of sources.podSelectors) {
    if (sel.namespace !== undefined && !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(sel.namespace)) {
      throw new Error(`Invalid gateway namespace ${JSON.stringify(sel.namespace)}.`);
    }
    for (const [k, v] of Object.entries(sel.labels)) {
      // The release-namespace expression is the single permitted helm value (see
      // RELEASE_NAMESPACE_EXPR); everything else must be a plain label value. Anything looser
      // would let a config-supplied string inject template directives into the chart.
      const valueOk =
        v === RELEASE_NAMESPACE_EXPR || /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(v);
      if (!/^[A-Za-z0-9]([-A-Za-z0-9_./]*[A-Za-z0-9])?$/.test(k) || !valueOk) {
        throw new Error(
          `Invalid ingress selector label ${JSON.stringify(k)}: ${JSON.stringify(v)}.`,
        );
      }
    }
  }

  const cidrFrom = sources.cidrs
    .map(
      (cidr) => `        - ipBlock:
            cidr: ${cidr}`,
    )
    .join("\n");
  const podSelectorFrom = sources.podSelectors
    .map((sel) => {
      const labels = Object.entries(sel.labels)
        .map(([k, v]) => `                ${k}: "${v}"`)
        .join("\n");
      const ns =
        sel.namespace !== undefined
          ? `\n          namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: "${sel.namespace}"`
          : "";
      return `        - podSelector:
            matchLabels:
${labels}${ns}`;
    })
    .join("\n");
  // Both lists render; an empty one contributes nothing.
  const googleLbFrom = [cidrFrom, podSelectorFrom].filter(Boolean).join("\n");

  // Operator-supplied node/subnet range(s): kubelet probe traffic (N19). Required
  // whenever strict is on — the guard below refuses to render without it.
  const nodeFrom = `{{- range .Values.global.networkPolicy.nodeCidrs }}
        - ipBlock:
            cidr: {{ . | quote }}
{{- end }}`;

  const routingPolicy = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${releaseName}-routing-service
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: routing-service
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: "${releaseName}"
      app.kubernetes.io/component: routing-service
  policyTypes:
    - Ingress
  ingress:
{{- if .Values.global.networkPolicy.strict }}
    - from:
${googleLbFrom}
      ports:
        - protocol: TCP
          port: 8443
    - from:
${nodeFrom}
      ports:
        - protocol: TCP
          port: 8081
{{- else }}
    - from:
${broadFrom}
      ports:
        - protocol: TCP
          port: 8443
        - protocol: TCP
          port: 8081
{{- end }}`;

  // One podSelector entry per pool component: any sibling pool may proxy to this one
  // (proxyToPool), but the routing service — same release label, different component —
  // never originates pool traffic and stays blocked.
  const siblingPoolSelectors = poolNames
    .map(
      (p) => `        - podSelector:
            matchLabels:
              app.kubernetes.io/name: "${releaseName}"
              app.kubernetes.io/component: "${p}"`,
    )
    .join("\n");

  // Pools serve the data path and the kubelet probe on the SAME port (3000), so the
  // strict posture cannot separate them by port the way the routing tier can.
  const poolPolicies = poolNames.map(
    (poolName) => `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  # N61: through sanitizeK8sName like every OTHER name in the chart — this was the one
  # resource name built by bare concatenation, so a composed name past the 63-char cap (or
  # one needing a trailing-hyphen strip) produced a name the API server rejects.
  name: ${sanitizeK8sName(`${releaseName}-${poolName}`)}
  labels:
    app.kubernetes.io/name: "${releaseName}"
    # N61: QUOTED — see the label comment in deployment.ts.
    app.kubernetes.io/component: "${poolName}"
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: "${releaseName}"
      app.kubernetes.io/component: "${poolName}"
  policyTypes:
    - Ingress
  ingress:
    - from:
{{- if .Values.global.networkPolicy.strict }}
${googleLbFrom}
${nodeFrom}
{{- else }}
${broadFrom}
{{- end }}
${siblingPoolSelectors}
      ports:
        - protocol: TCP
          port: 3000`,
  );

  // The strict posture needs no pod CIDR at all (it never names the pod range), so it
  // also renders when discovery produced nothing — an operator who opted into strict
  // gets isolation even alongside --allow-no-network-policy.
  return `{{- if or .Values.global.networkPolicy.podCidrs .Values.global.networkPolicy.strict }}
{{- if and .Values.global.networkPolicy.strict (not .Values.global.networkPolicy.nodeCidrs) }}
{{- fail "global.networkPolicy.strict requires global.networkPolicy.nodeCidrs: kubelet liveness/readiness probes come from the NODE ip, which the Google load-balancer ranges do not cover, and with Calico a strict allowlist without it leaves every pod unready. Set it to the cluster subnet range(s), e.g. --set 'global.networkPolicy.nodeCidrs={10.128.0.0/20}' (gcloud compute networks subnets describe SUBNET --region REGION --format='value(ipCidrRange)')." }}
{{- end }}
${[routingPolicy, ...poolPolicies].join("\n---\n")}
{{- end }}
`;
}
