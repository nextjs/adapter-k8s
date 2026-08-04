// src/emit/helm.ts
import { createHash } from "node:crypto";
import type { K8sAdapterConfig, PoolDefinition, RoutingManifest } from "../types.js";
import { renderChartYaml } from "./templates/chart-yaml.js";
import { renderInternalSecret } from "./templates/internal-secret.js";
import { renderValkeySecret } from "./templates/valkey-secret.js";
import { renderValuesYaml } from "./templates/values-yaml.js";
import { renderDeployment } from "./templates/deployment.js";
import { renderService, renderActiveService } from "./templates/service.js";
import { renderHPA } from "./templates/hpa.js";
import {
  renderRoutingManifestConfigMap,
  renderRoutingManifestSnapshotConfigMap,
} from "./templates/routing-manifest-configmap.js";
import { sanitizeK8sName } from "./templates/utils.js";
import { renderRoutingServiceDeployment } from "./templates/routing-service-deployment.js";
import { renderRoutingServiceService } from "./templates/routing-service-service.js";
import { renderRoutingServiceHPA } from "./templates/routing-service-hpa.js";
import {
  renderRouteExtConfigMap,
  routeExtDocumentDigest,
} from "./templates/route-ext-configmap.js";
import { renderNetworkPolicies } from "./templates/network-policy.js";
import { resolveProvider } from "../providers/index.js";

/**
 * Chart files that carry secret material. The write site (adapter.ts) MUST create these
 * with mode 0600 — they hold the internal dispatch secret / Valkey AUTH and must not be
 * group/world-readable on disk. Single source of truth lives here, next to where the
 * files are generated.
 */
export const SECRET_CHART_FILES: ReadonlySet<string> = new Set([
  "templates/internal-secret.yaml",
  "templates/valkey-secret.yaml",
]);

/**
 * S25 (SECURITY). The set above is a hardcoded pair matched by exact filename, and adapter.ts
 * picks mode 0600 from membership in it — so a THIRD secret-bearing template would land 0644
 * with nothing failing anywhere. Verify it against the rendered content instead of trusting
 * the list to be maintained: every emitted template whose body declares `kind: Secret` must be
 * in the set, and every member must actually be one. Same shape as
 * assertCacheKeyClassification — a new file is a loud build failure, not a silent downgrade.
 */
export function assertSecretChartFilesComplete(files: Record<string, string>): void {
  const declaresSecret = (body: string): boolean => /^kind: Secret$/m.test(body);
  for (const [name, body] of Object.entries(files)) {
    if (!name.startsWith("templates/")) continue;
    if (declaresSecret(body) && !SECRET_CHART_FILES.has(name)) {
      throw new Error(
        `Chart template "${name}" renders a Kubernetes Secret but is not listed in ` +
          `SECRET_CHART_FILES (emit/helm.ts), so it would be written world-readable ` +
          `(0644) instead of 0600. Add it to the set.`,
      );
    }
  }
  for (const name of SECRET_CHART_FILES) {
    const body = files[name];
    if (body !== undefined && !declaresSecret(body)) {
      throw new Error(
        `"${name}" is listed in SECRET_CHART_FILES but no longer renders a Secret. Remove it ` +
          `so the list keeps meaning "these files hold credentials".`,
      );
    }
  }
}

export function generateHelmChart({
  pools,
  buildId,
  nextVersion,
  config,
  imageRegistry,
  routingManifest,
  releaseName = "nextjs",
  extensionChainJson,
  routingFailOpen,
  infrastructure,
  internalSecret,
  imageDigests,
  deploymentId,
}: {
  pools: Map<string, PoolDefinition>;
  buildId: string;
  nextVersion: string;
  config: K8sAdapterConfig;
  imageRegistry: string;
  routingManifest: RoutingManifest;
  releaseName?: string;
  extensionChainJson?: string;
  /** Mirrors the GCP callout failOpen to the server (ROUTING_FAIL_OPEN) for a consistent policy. */
  routingFailOpen?: boolean;
  infrastructure?: { projectId?: string; region?: string };
  /** next.config `deploymentId`, rendered as NEXT_DEPLOYMENT_ID into pool + routing pods. */
  deploymentId?: string;
  /**
   * Shared secret authenticating internal dispatch headers between the routing service and the
   * pools. Both deployments read it from the rendered Secret, so they always agree.
   *
   * REQUIRED (N50, review #20): this used to be `internalSecret ?? randomBytes(32)`, and
   * adapter.ts never passed a value — so every chart render minted a NEW secret. Two
   * consequences: (1) regenerating the chart for an unchanged build produced a different
   * chart, which defeats the only audit for invariant 5 ("clean chart regeneration" — diff
   * the regenerated chart against what was applied); (2) worse, the rotated Secret is
   * applied while the CURRENTLY-SERVING pods still hold the old value, so for the whole
   * rollout window they stop trusting the routing service's dispatch headers and re-run
   * middleware locally — middleware executes TWICE per request, which is not neutral for
   * rate-limit counters or analytics. Making it a required argument means no render can
   * invent one; the caller derives it deterministically per build (adapter.ts
   * deriveInternalSecret: HMAC of the build id under an operator-held key).
   */
  internalSecret: string;
  /**
   * N72 (templates-agent handoff). Immutable image digests (`sha256:<64 hex>`) for the
   * emitted Deployments — keyed by pool name, plus `routingService` for the ext_proc tier.
   * When a digest is supplied the rendered pod template references
   * `<registry>/<repo>@sha256:…` with `imagePullPolicy: IfNotPresent`; without it the
   * reference is the mutable build-id TAG with `imagePullPolicy: Always`, so a retag can
   * never be silently served from a node's cached layer.
   *
   * Nothing supplies these at BUILD time and nothing can: `next build` runs before
   * `docker build`/`docker push`, so no digest exists yet. This is the seam for the
   * deploy-side resolve-after-push step (see the handoff note in adapter.ts) — the chart
   * must be re-rendered, or the digests injected, only once the images are pushed. A
   * retained previous-build render must reuse the digest RECORDED FOR THAT BUILD; never
   * re-resolve it from the tag, which is the very thing that may have moved.
   */
  imageDigests?: Record<string, string>;
}): Record<string, string> {
  const files: Record<string, string> = {};
  const provider = resolveProvider(config);
  const secret = internalSecret;
  // N87: per-BUILD Secret name (and therefore one Secret per live build, annotated
  // `helm.sh/resource-policy: keep`). The FILENAME stays `templates/internal-secret.yaml`
  // so SECRET_CHART_FILES / assertSecretChartFilesComplete above are unaffected and the
  // file still lands mode 0600.
  files["templates/internal-secret.yaml"] = renderInternalSecret({ releaseName, buildId, secret });
  // BYO cache: emit the Valkey connection Secret from config. Managed Memorystore instead
  // creates this Secret imperatively at deploy time (URL known only after provisioning).
  if (config.cache?.enabled && config.cache.url) {
    files["templates/valkey-secret.yaml"] = renderValkeySecret({
      releaseName,
      url: config.cache.url,
      ...(config.cache.password ? { password: config.cache.password } : {}),
    });
  }
  // N50 (review #23). Helm validates chart.metadata.version as STRICT SemVer 2.0.0 on
  // every invocation (`template`, `upgrade`, `rollback`) — i.e. after the build and the
  // image push. The prerelease suffix is derived from the build id, and SemVer's rules on
  // prerelease identifiers are narrower than they look:
  //   - a purely NUMERIC identifier may not have a leading zero, so a date-style build id
  //     ("2026.07.25") rendered `0.1.0-2026.07.25` → real helm:
  //     `Error: validation: chart.metadata.version "0.1.0-2026.07.25" is invalid`, exit 1,
  //     on EVERY deploy;
  //   - no identifier may be empty, so a trailing `.` ("1.2.", which the old
  //     `.slice(0, 32)` could also produce by cutting on a dot) was equally fatal.
  // BUILD_ID_RE deliberately permits `.`, and date/git-describe style ids are a documented
  // pattern here, so this was reachable from a one-line `generateBuildId`.
  // Fix: build the suffix from [a-z0-9] only (every other run collapses to a single `-`,
  // which is legal INSIDE an identifier) and always append `b<8-hex build-id digest>`. The
  // digest keeps ids that collapse to the same suffix distinct, and its leading letter
  // guarantees the identifier is never purely numeric — so the leading-zero rule can never
  // bite again, whatever the build id.
  const buildIdDigest = createHash("sha256").update(buildId).digest("hex").slice(0, 8);
  const safeVersionSuffix = buildId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    // Cap BEFORE stripping the trailing hyphen — the slice can land on one.
    .slice(0, 22)
    .replace(/-+$/, "");

  files["Chart.yaml"] = renderChartYaml({
    name: releaseName,
    version: `0.1.0-${[safeVersionSuffix, `b${buildIdDigest}`].filter(Boolean).join("-")}`,
  });
  files["values.yaml"] = renderValuesYaml({
    pools,
    buildId,
    nextVersion,
    config,
    imageRegistry,
  });

  // Routing and Config
  const routingManifestJson = JSON.stringify(routingManifest, null, 2);
  files["templates/routing-manifest-configmap.yaml"] = renderRoutingManifestConfigMap({
    releaseName,
    routingManifestJson,
  });
  // PER-BUILD manifest CM — the one the routing Deployment actually mounts (2026-07-30).
  // The stable CM above is kept for compatibility: pre-change retained renders and the
  // revert path still reference it, and it costs one small object per release.
  files["templates/routing-manifest-snapshot-configmap.yaml"] =
    renderRoutingManifestSnapshotConfigMap({
      releaseName,
      buildId,
      routingManifestJson,
    });

  // The ingress tier (Gateway + route + any CDN attachment) is the first seam to move behind
  // the provider interface — see plans/multi-provider-aks-eks-generic.md. Emitting nothing when
  // no gateway is configured stays the provider's decision, not this caller's.
  Object.assign(
    files,
    provider.emitIngressTemplates({
      releaseName,
      pools,
      routingManifest,
      config,
    }),
  );

  // NetworkPolicies for both workload tiers. Always emitted — the template is wrapped
  // in a helm `if` on global.networkPolicy.podCidrs, so it renders nothing until the
  // deploy CLI discovers the cluster pod CIDRs and sets the value.
  files["templates/network-policy.yaml"] = renderNetworkPolicies({
    releaseName,
    poolNames: [...pools.keys()],
    // The STRICT posture's admitted sources come from the provider: Google CIDRs on GKE, the
    // release's own Envoy proxy pods on an in-cluster gateway. Reachability to the routing
    // tier's :8443 IS the internal dispatch secret, so this is the control that makes the
    // in-cluster h2c hop safe.
    ingressSources: provider.strictIngressSources({
      releaseName,
      pools,
      routingManifest,
      config,
    }),
  });

  for (const poolName of pools.keys()) {
    // Per-pool env merges OVER the shared map, and per-pool envFrom is appended AFTER the
    // shared sources — both match Kubernetes' own "last one wins" semantics, so a pool
    // override behaves the way someone reading the rendered pod spec would predict.
    const poolConfig = config.pools?.[poolName];
    const mergedEnv = { ...(config.env ?? {}), ...(poolConfig?.env ?? {}) };
    const mergedEnvFrom = [...(config.envFrom ?? []), ...(poolConfig?.envFrom ?? [])];
    files[`templates/${poolName}-deployment.yaml`] = renderDeployment({
      poolName,
      buildId,
      releaseName,
      ...(imageDigests?.[poolName] ? { imageDigest: imageDigests[poolName]! } : {}),
      ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
      ...(mergedEnvFrom.length > 0 ? { envFrom: mergedEnvFrom } : {}),
      ...(deploymentId !== undefined ? { deploymentId } : {}),
    });
    files[`templates/${poolName}-service.yaml`] = renderService({
      poolName,
      buildId,
      releaseName,
    });
    // Stable "active" Service — HTTPRoute points here, selector patched on cutover
    files[`templates/${poolName}-active-service.yaml`] = renderActiveService({
      poolName,
      releaseName,
      emitHealthCheckPolicy: provider.emitsHealthCheckPolicyCrd,
    });
    files[`templates/${poolName}-hpa.yaml`] = renderHPA({
      poolName,
      buildId,
      releaseName,
    });
  }

  // Phase 2: the ext_proc routing tier.
  //
  // WHAT GATES IT is provider-dependent. On GKE the tier is useless without a registered GXLB
  // traffic extension, so `extensionChainJson` is both the trigger and the proof that init has
  // run. An `envoy-gateway` provider has no chain and no GCP infrastructure at all — its
  // registration is an in-cluster EnvoyExtensionPolicy — so gating on the chain there emitted a
  // chart with NO routing tier: the app served, nothing looked broken, and every request
  // silently fell back to pool-local middleware. The edge tier this adapter exists for was
  // simply absent.
  const wantsRoutingTier =
    provider.extProcStrategy === "envoy-gateway" ? true : Boolean(extensionChainJson);
  if (wantsRoutingTier) {
    const rs = config.routingService;
    files["templates/routing-service-deployment.yaml"] = renderRoutingServiceDeployment({
      releaseName,
      buildId,
      imageRegistry,
      ...(rs?.resources ? { resources: rs.resources } : {}),
      transport: provider.routingTransport,
      ...(routingFailOpen !== undefined ? { failOpen: routingFailOpen } : {}),
      ...(rs?.requestTimeoutMs !== undefined ? { requestTimeoutMs: rs.requestTimeoutMs } : {}),
      ...(imageDigests?.routingService ? { imageDigest: imageDigests.routingService } : {}),
      // TOP-LEVEL env only (no pool merge — middleware belongs to no pool): NODE-runtime
      // middleware executes in this container and reads process.env at request time
      // (full run, middleware-general "allows to access env variables").
      ...(Object.keys(config.env ?? {}).length > 0 ? { env: config.env } : {}),
      ...((config.envFrom ?? []).length > 0 ? { envFrom: config.envFrom } : {}),
      ...(deploymentId !== undefined ? { deploymentId } : {}),
    });
    files["templates/routing-service-service.yaml"] = renderRoutingServiceService({
      releaseName,
      annotations: provider.routingServiceAnnotations({
        releaseName,
        pools,
        routingManifest,
        config,
      }),
    });
    files["templates/routing-service-hpa.yaml"] = renderRoutingServiceHPA({
      releaseName,
      ...(rs?.scaling?.min !== undefined ? { minReplicas: rs.scaling.min } : {}),
      ...(rs?.scaling?.max !== undefined ? { maxReplicas: rs.scaling.max } : {}),
      ...(rs?.scaling?.targetCPU !== undefined ? { targetCPU: rs.scaling.targetCPU } : {}),
    });
    // Second seam: HOW the ext_proc callout attaches to the data plane. GKE emits a
    // privileged gcloud registration Job; envoy-gateway providers emit an
    // EnvoyExtensionPolicy and need no cloud IAM at all.
    Object.assign(
      files,
      provider.emitExtProcTemplates({
        releaseName,
        pools,
        routingManifest,
        config,
        buildId,
        infrastructure,
        extensionChainJson,
        routeExtDocumentDigest,
        routingFailOpen,
        ...(config.routingService?.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: config.routingService.requestTimeoutMs }
          : {}),
      }),
    );
  }

  // S25: a secret-bearing template that is not in SECRET_CHART_FILES would be written 0644.
  assertSecretChartFilesComplete(files);
  return files;
}
