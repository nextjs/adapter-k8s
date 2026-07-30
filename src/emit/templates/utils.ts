// src/emit/templates/utils.ts
import { createHash } from "node:crypto";

/**
 * The ONLY namespace this adapter deploys to. init binds Workload Identity to
 * `default/<release>-deploy-sa`, and every kubectl/helm call in the CLI pins this
 * literal instead of trusting the operator's current context. Build time
 * (adapter.ts) and deploy time (deploy.ts) both REJECT an infrastructure.json
 * `namespace` other than this: honoring it only in the ext_proc extension-chain
 * authority (extension-chain.ts) while workloads land in "default" skewed the
 * GXLB callout target and failed every edge callout.
 */
export const K8S_NAMESPACE = "default";

export function sanitizeK8sName(name: string, suffix = ""): string {
  // Lowercase, replace non-alphanumeric with hyphens
  let sanitized = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
  // Ensure it starts with a letter (prepend BEFORE truncation so the prefix survives)
  if (!/^[a-z]/.test(sanitized)) {
    sanitized = `b-${sanitized}`;
  }
  // Truncate to 63 characters (DNS-1035/1123 limit) FIRST — otherwise stripping
  // trailing hyphens before truncating lets the slice reintroduce one. When the
  // caller appends a fixed suffix (-hpa, -hcp), reserve room for it INSIDE the
  // limit: truncating to 63 and appending after would emit a 67-char name that
  // the API server rejects. Two names that differ only past the reserved
  // boundary collide — see the build-id duplicate-sanitized-name guard in
  // adapter.ts, which is what makes such collisions fail loudly instead.
  sanitized = sanitized.slice(0, 63 - suffix.length);
  // Strip leading/trailing hyphens so the name starts and ends alphanumeric.
  // The leading `b-` guarantees a surviving leading letter, so this never empties the string.
  sanitized = sanitized.replace(/^-+/, "").replace(/-+$/, "");
  return sanitized + suffix;
}

/**
 * The per-build retained routing-manifest snapshot ConfigMap name (see
 * routing-manifest-configmap.ts, which re-exports this — it lives here so the
 * build-id collision helper below can use it without an import cycle).
 *
 * Naming: a 40-char release plus the old fixed `-routing-manifest-` infix left ~5
 * build-id chars before the 63-char truncation — date-style build ids collided, and
 * rollback would mount the WRONG build's manifest. The short `-rm-` infix keeps the
 * name readable, and an 8-hex-char SHA-256 digest of the FULL build id is appended
 * as a sanitizeK8sName suffix, which is reserved INSIDE the 63-char cap — truncation
 * can eat the readable build-id portion but never the digest, so distinct build ids
 * always yield distinct snapshot names (same scheme as routeExtJobName).
 */
export function routingManifestSnapshotName(releaseName: string, buildId: string): string {
  const digest = createHash("sha256").update(buildId).digest("hex").slice(0, 8);
  return sanitizeK8sName(`${releaseName}-rm-${buildId}`, `-${digest}`);
}

/**
 * The per-pool, per-build sanitized resource names EXACTLY as the templates render
 * them: the versioned Deployment (deployment.ts) and its same-named Service
 * (service.ts), the `-hpa` variant (hpa.ts) and the `-hcp` variant (service.ts) —
 * the suffix variants reserve their suffix INSIDE the 63-char cap, so their
 * truncation boundary sits at 59, four chars EARLIER than the base name. The CLI
 * must derive HPA/HCP names through this helper, never by concatenating "-hpa" /
 * "-hcp" onto the already-63-truncated deployment name: past the 59-char boundary
 * the two diverge (and the concatenation is an invalid 64-67-char name), so
 * rollback missed the retained HPA and deploy's scale-down failed to delete the
 * real one — the autoscaler then rescaled the parked previous build.
 */
export interface PoolResourceNames {
  /** Versioned Deployment AND versioned Service (they share this name). */
  deployment: string;
  hpa: string;
  hcp: string;
}

export function poolResourceNames(
  releaseName: string,
  poolName: string,
  buildId: string,
): PoolResourceNames {
  const base = `${releaseName}-${poolName}-${buildId}`;
  return {
    deployment: sanitizeK8sName(base),
    hpa: sanitizeK8sName(base, "-hpa"),
    hcp: sanitizeK8sName(base, "-hcp"),
  };
}

/**
 * Every sanitized, truncation-prone K8s resource name a build stamps for the given
 * pools: per-pool versioned Deployment/Service names (deployment.ts / service.ts),
 * their `-hpa` (hpa.ts) and `-hcp` (service.ts) suffix variants — which truncate at
 * 59, four chars EARLIER than the base name — and the routing-manifest snapshot
 * ConfigMap. Single source of truth for the composed-name set: compare COMPOSED
 * names, not the bare build id, because `${release}-${pool}-` can consume the
 * entire 63-char budget and truncate the build id away entirely.
 */
export function composedBuildResourceNames(
  releaseName: string,
  poolNames: string[],
  buildId: string,
): string[] {
  const names: string[] = [];
  for (const poolName of poolNames) {
    const { deployment, hpa, hcp } = poolResourceNames(releaseName, poolName, buildId);
    names.push(deployment, hpa, hcp);
  }
  names.push(routingManifestSnapshotName(releaseName, buildId));
  return names;
}

/**
 * N62. The FULL set of truncation-prone names the chart emits for a set of build ids,
 * bucketed by the kind whose namespace they share. K8s name uniqueness is per kind, so
 * the comparison must be too — an earlier flat cross-kind set false-positived on build
 * ids like "foo" vs "foo-hpa" (build "foo"'s HPA shares a NAME with build "foo-hpa"'s
 * Deployment, but a Deployment and an HPA with the same name coexist fine).
 *
 * Two DIFFERENT collision classes live in these buckets, and the guard has to catch both:
 *
 *  1. current-build-vs-previous-build, per pool (the original blue/green concern): a
 *     shared same-kind name means the new Deployment/Service/HPA/HealthCheckPolicy
 *     adopts or shadows the serving one mid-cutover.
 *  2. CROSS-POOL, within a SINGLE build (N62): a pool named `<otherPool>-<buildId>`
 *     makes pool `<otherPool>`'s VERSIONED name equal pool `<otherPool>-<buildId>`'s
 *     STABLE (active) name. Verified: pools `api` + `api-v2` with buildId `v2` both
 *     render a Service (and a HealthCheckPolicy) named `nextjs-api-v2` — one selector
 *     pinned to `version: v2`, the other `{{ .Values.activeBuildId }}`. helm emits both
 *     silently and last-writer-wins, so pool `api-v2`'s HTTPRoute backendRef can resolve
 *     to pool `api`'s pods and the cutover patch flips the wrong object's selector. The
 *     old guard compared only current-vs-previous per pool, so it never looked at a
 *     versioned name against another pool's stable name.
 *
 * The `${releaseName}-routing-service` names are in the buckets for the same reason: a
 * pool named `routing` with buildId `service` renders a versioned Deployment/Service
 * named exactly like the routing tier's (config.ts only reserves the literal pool name
 * "routing-service", which does not cover that composition).
 *
 * Returns the first same-kind colliding name plus its kind (for the error message), or
 * null when every name is distinct. Build ids are NOT de-duplicated: passing the same id
 * twice is itself a collision (two builds that sanitize identically), which is what the
 * build-time guard in adapter.ts relies on.
 */
export function findEmittedNameCollision(
  releaseName: string,
  poolNames: string[],
  buildIds: string[],
): { kind: string; name: string } | null {
  // Bucket => every name the chart stamps in that kind's namespace, in emission order.
  const buckets: Array<[string, string[]]> = [];

  const deploymentish: string[] = [];
  const hpas: string[] = [];
  const hcps: string[] = [];
  for (const buildId of buildIds) {
    for (const pool of poolNames) {
      const { deployment, hpa, hcp } = poolResourceNames(releaseName, pool, buildId);
      deploymentish.push(deployment);
      hpas.push(hpa);
      hcps.push(hcp);
    }
  }
  // Stable per-pool names (renderActiveService) — one per pool, no build id.
  for (const pool of poolNames) {
    deploymentish.push(sanitizeK8sName(`${releaseName}-${pool}`));
    hcps.push(sanitizeK8sName(`${releaseName}-${pool}`, "-hcp"));
  }
  // The routing tier (routing-service-deployment.ts / -service.ts / -hpa.ts).
  deploymentish.push(`${releaseName}-routing-service`);
  hpas.push(`${releaseName}-routing-service-hpa`);

  buckets.push(["Deployment/Service", deploymentish]);
  buckets.push(["HorizontalPodAutoscaler", hpas]);
  buckets.push(["HealthCheckPolicy", hcps]);
  // Snapshot names embed an 8-hex digest of the FULL build id, so distinct build
  // ids can't realistically collide here — kept for completeness (the digest IS
  // truncation-proof, but the guard should not silently assume that).
  buckets.push([
    "ConfigMap",
    buildIds.map((buildId) => routingManifestSnapshotName(releaseName, buildId)),
  ]);

  for (const [kind, names] of buckets) {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) return { kind, name };
      seen.add(name);
    }
  }
  return null;
}

/**
 * Blue/green pairwise wrapper over {@link findEmittedNameCollision} — kept as the entry
 * point the build-time guard (adapter.ts) and the deploy-time guard (deploy.ts) call so
 * both sides agree on the same name set.
 */
export function findBuildIdNameCollision(
  releaseName: string,
  poolNames: string[],
  currentBuildId: string,
  previousBuildId: string,
): { kind: string; name: string } | null {
  return findEmittedNameCollision(releaseName, poolNames, [currentBuildId, previousBuildId]);
}

// Values below are spliced into shell scripts, `helm --set` assignments, K8s resource
// names, and YAML that runs under privileged Workload-Identity service accounts. Guard
// against injection / invalid-name errors at the boundary — never interpolate raw.
//
// releaseName is capped at 40 chars: it is prefixed into longer resource names
// (`${releaseName}-routing-service`, GKE cluster `${releaseName}-cluster`, etc.) that
// must each fit their own length limits (63 for K8s names, 40 for GKE clusters).
// Edge hyphens are rejected — the templates embed releaseName at the start of DNS-1123
// resource names, where a leading/trailing hyphen renders an invalid name.
// S17: the charset legitimately admits YAML 1.1 booleans (`on`, `no`, `y`) and all-numeric
// names, which the API server then refuses to unmarshal into map[string]string
// ("cannot unmarshal bool into … metadata.labels"). N61 quoted the POOL name at every label
// and selector for exactly this reason but left the release name bare; every template now
// quotes it too, which is the fix that also covers names added later.
const RELEASE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION_RE = /^[a-z0-9-]+$/;
// DNS-1123 hostname, optionally with a single left-most wildcard label (`*.example.com`).
// Lowercase only, no whitespace/quotes — safe to embed in a quoted YAML scalar.
const HOSTNAME_RE =
  /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
// OCI registry/repository prefix (no tag — the tag is the build id, applied separately).
// Lowercase alnum with `.`/`_`/`-` separators and `/` path segments. The FIRST segment may
// carry a `:port` — that is standard OCI host syntax (localhost:5511/x, registry.lan:5000/x),
// and only a colon in the LAST segment would be a tag. This validator used to reject every
// ported registry while its sibling IMAGE_REFERENCE_RE below allowed them — found by Phase
// 2's first local-cluster deploy dying on "localhost:5511/adapter-e2e".
const IMAGE_REGISTRY_RE =
  /^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]{1,5})?(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/;
// Next.js build ids (default or from `generateBuildId()` — commonly a git ref in CI).
// Excludes helm `--set` metacharacters (`,` `\`) and YAML/template breakouts (`"` `'` `{`).
const BUILD_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const NAMESPACE_RE = /^[a-z0-9-]{1,63}$/;
// GCS bucket naming rules (https://cloud.google.com/storage/docs/buckets#naming).
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

export function assertSafeReleaseName(releaseName: string): void {
  if (!RELEASE_NAME_RE.test(releaseName)) {
    throw new Error(
      `Invalid releaseName "${releaseName}": must match ${RELEASE_NAME_RE} ` +
        `(lowercase letters, digits, and hyphens only, max 40 chars, ` +
        `must start and end with a letter or digit).`,
    );
  }
}

export function assertSafeHostname(hostname: string): void {
  if (hostname.length > 253 || !HOSTNAME_RE.test(hostname)) {
    throw new Error(
      `Invalid hostname "${hostname}": must be a DNS-1123 hostname ` +
        `(optionally wildcard-prefixed like "*.example.com").`,
    );
  }
}

/**
 * adapter.ts's hardcoded placeholder for "no container registry configured at build time"
 * (`infra.containerRegistry ?? process.env.IMAGE_REGISTRY ?? "REGISTRY"`) — deploy always
 * replaces it with `--set global.image.registry=…`. It is a literal in our own source, not
 * operator input, and it is deliberately NOT a valid registry path, so the consumption-point
 * guards exempt it by identity rather than loosening IMAGE_REGISTRY_RE to admit uppercase.
 */
export const UNCONFIGURED_IMAGE_REGISTRY = "REGISTRY";

export function assertSafeImageRegistry(registry: string): void {
  if (registry.length > 255 || !IMAGE_REGISTRY_RE.test(registry)) {
    throw new Error(
      `Invalid image registry "${registry}": must be a lowercase registry/repository ` +
        `path (e.g. "us-central1-docker.pkg.dev/my-project/nextjs"), no tag or scheme.`,
    );
  }
}

// N66. A COMPLETE OCI image reference, as read back from a running Deployment's container
// spec and re-interpolated into a double-quoted YAML scalar for a retained render:
// `<registry>/<repo>[:tag][@sha256:…]`. Deliberately excludes the `"`/`\`/whitespace that
// could break the scalar, and any scheme.
const IMAGE_REFERENCE_RE =
  /^[a-z0-9][a-z0-9._-]*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/;

export function assertSafeImageReference(image: string): void {
  if (image.length > 512 || !IMAGE_REFERENCE_RE.test(image)) {
    throw new Error(
      `Invalid image reference "${image}": must be a plain OCI reference ` +
        `(e.g. "us-central1-docker.pkg.dev/p/r/nextjs-app-ssr:build1" or the same with ` +
        `"@sha256:<64 hex>"), with no scheme, quotes, or whitespace.`,
    );
  }
}

export function assertSafeBuildId(buildId: string): void {
  if (!BUILD_ID_RE.test(buildId)) {
    throw new Error(
      `Invalid buildId "${buildId}": must match ${BUILD_ID_RE} ` +
        `(letters, digits, ".", "_", "-" only, max 128 chars). ` +
        `If you set generateBuildId() in next.config, restrict its output to this charset.`,
    );
  }
}

export function assertSafeNamespace(namespace: string): void {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new Error(
      `Invalid namespace "${namespace}": must match ${NAMESPACE_RE} ` +
        `(lowercase letters, digits, and hyphens only, max 63 chars).`,
    );
  }
}

// A route/output pathname is spliced into a DOUBLE-QUOTED YAML scalar in the
// generated HTTPRoute (`path: { value: "<prefix>" }`, gateway.ts). A `"` breaks out
// of the scalar (chart-YAML injection), a `\` is an invalid YAML escape, and a
// control character silently folds. Reject at manifest time — the earliest point
// all pathnames pass through — rather than at each sink.
export function assertSafePathname(pathname: string): void {
  // eslint-disable-next-line no-control-regex
  if (/["\\\x00-\x1f\x7f]/.test(pathname)) {
    throw new Error(
      `Unsafe pathname ${JSON.stringify(pathname)}: route pathnames must not contain ` +
        `double quotes, backslashes, or control characters (they are interpolated into ` +
        `quoted YAML in the generated HTTPRoute). Rename the offending route/file.`,
    );
  }
}

// N67. Values read back out of an operator-mutable `extension-chains.json` and spliced
// into DOUBLE-QUOTED YAML scalars in route-extension.yaml — the file a privileged
// Workload Identity then hands to `gcloud service-extensions … import`. The CEL
// expression beside them got a carefully documented single-quote treatment; these got
// nothing. Reject rather than escape (same call as assertSafePathname): a `"` breaks out
// of the scalar, a `\` is an invalid YAML escape unless it starts a real escape sequence,
// and a control character folds silently.
/**
 * S5 (SECURITY). Neutralize Helm template actions in OPAQUE data spliced into a chart file.
 *
 * Everything under a chart's `templates/` directory is evaluated by Helm's Go template engine
 * BEFORE the YAML is parsed. The routing manifest and the Valkey AUTH string are opaque
 * payloads — derived from the app's own `next.config` (headers/rewrites/redirects/matchers) and
 * from gcloud output — that are embedded verbatim into `templates/*.yaml`, and `JSON.stringify`
 * does not touch braces. So a `next.config` response-header value of
 * `{{ index (lookup "v1" "Secret" "ns" "name").data "token" }}` was EXECUTED at
 * `helm upgrade` time with the deployer's credentials, and the looked-up secret was then
 * served as a response header by handler.ts/dispatch.ts. Verified against real helm: a value of
 * `{{ mul 7 6 }}` rendered as `42`.
 *
 * `{{ "{{" }}` is Helm's own idiom for a literal `{{`, so the rendered output is byte-identical
 * to the intended text — the escape is invisible in the deployed object and cannot corrupt a
 * value that legitimately contains braces (a CSS-in-JS header, a templated CSP).
 *
 * Escaping rather than rejecting is deliberate: `{{` in an app's config is legal and the
 * adapter must not fail a build over it. The structural alternative — moving opaque payloads
 * out of `templates/` and pulling them in with `.Files.Get` (which returns raw, unevaluated
 * text) — is the belt-and-braces version and would also remove the sequence from the chart
 * source entirely; this escape is the fix that needs no chart-layout change.
 */
export function escapeHelmActions(value: string): string {
  return value.includes("{{") ? value.split("{{").join('{{ "{{" }}') : value;
}

/**
 * S29 (SECURITY). The CEL match condition goes into a SINGLE-quoted YAML scalar (a
 * double-quoted one cannot carry CEL's `\'` escape), so its unsafe set differs from
 * assertSafeYamlScalar's: a single quote is legal (it round-trips as `''`), but a control
 * character folds inside the scalar and a backslash-newline pair can end it. Reject rather
 * than escape — escapeCelString percent-encodes everything outside the RFC-3986 path set, so
 * anything else means the generated JSON was edited.
 */
export function assertSafeCelScalar(value: string, field: string): void {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field}: expected a string, got ${JSON.stringify(value)}.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(
      `Unsafe ${field} ${JSON.stringify(value)}: must not contain control characters — it is ` +
        `interpolated into a single-quoted YAML scalar that a privileged \`gcloud … import\` ` +
        `consumes, where a raw newline injects sibling keys into the extension chain.`,
    );
  }
}

/**
 * The pathnames the platform reserves for its own probes. Kept in step with
 * pool-server/server.ts LIVENESS_PATH / READINESS_PATH and with the chart's probe +
 * HealthCheckPolicy paths (deployment.ts, service.ts).
 */
export const RESERVED_PROBE_PATHS = ["/healthz", "/readyz"] as const;

/**
 * Fail the build when the app owns a platform probe path. See the call site in adapter.ts for
 * why this is a build error rather than a runtime shadow.
 */
export function assertProbePathsUnowned(app: {
  pathnames: readonly string[];
  staticPathnames: readonly string[];
  publicPathnames: readonly string[];
  basePath?: string;
}): void {
  const basePath = app.basePath ?? "";
  const owned = new Map<string, string>();
  const record = (pathname: string, kind: string): void => {
    if (typeof pathname !== "string") return;
    // Probes are requested WITHOUT the basePath (the kubelet and the health check target the
    // pod directly), so compare both forms.
    const bare =
      basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname;
    for (const candidate of new Set([pathname, bare || "/"])) {
      if (
        (RESERVED_PROBE_PATHS as readonly string[]).includes(candidate) &&
        !owned.has(candidate)
      ) {
        owned.set(candidate, kind);
      }
    }
  };
  for (const p of app.pathnames) record(p, "a route");
  for (const p of app.staticPathnames) record(p, "a static output");
  for (const p of app.publicPathnames) record(p, "a public/ file");
  if (owned.size === 0) return;
  const details = [...owned.entries()].map(([p, kind]) => `${p} (${kind})`).join(", ");
  throw new Error(
    `[adapter-k8s] The app owns a reserved platform probe path: ${details}. ` +
      `${RESERVED_PROBE_PATHS.join(" and ")} are answered by the pool server itself — the ` +
      `kubelet's liveness/readiness probes, the Gateway HealthCheckPolicy, and the blue/green ` +
      `cutover gate all read them as this pod's verdict. If the app answered them instead, a ` +
      `static 200 would promote a pod whose instrumentation failed, and an authenticated or ` +
      `failing route would keep a healthy pod unready so no deploy could ever cut over. ` +
      `Rename the route/file (e.g. /health, /api/ready).`,
  );
}

export function assertSafeYamlScalar(value: string, field: string): void {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field}: expected a string, got ${JSON.stringify(value)}.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/["\\\x00-\x1f\x7f]/.test(value)) {
    throw new Error(
      `Unsafe ${field} ${JSON.stringify(value)}: must not contain double quotes, ` +
        `backslashes, or control characters — it is interpolated into a double-quoted ` +
        `YAML scalar that a privileged \`gcloud … import\` consumes.`,
    );
  }
}

export function assertSafeBucketName(bucket: string): void {
  if (!BUCKET_RE.test(bucket)) {
    throw new Error(
      `Invalid bucket name "${bucket}": must match ${BUCKET_RE} ` +
        `(lowercase letters, digits, ".", "_", "-" only, 3-63 chars).`,
    );
  }
}

export function assertSafeProjectId(projectId: string): void {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(
      `Invalid projectId "${projectId}": must be a valid GCP project id ` +
        `(${PROJECT_ID_RE}: 6-30 chars, starts with a letter, lowercase letters/digits/hyphens).`,
    );
  }
}

export function assertSafeRegion(region: string): void {
  if (!REGION_RE.test(region)) {
    throw new Error(
      `Invalid region "${region}": must match ${REGION_RE} ` +
        `(lowercase letters, digits, and hyphens only).`,
    );
  }
}

// N60 (SECURITY). Kubernetes resource quantities from `next.config`
// (`pools.*.resources.*`, `routingService.resources.*`) reach the rendered pod spec
// through TWO sinks, and NEITHER escaped anything before this validator existed:
//   - values.yaml -> `{{ (index .Values.pools "<p>").resources… }}` (deployment.ts).
//     helm does no escaping, so a value containing `"` + newline breaks out of the
//     quoted scalar. VERIFIED by rendering: memoryLimit
//     `512Mi"\n      hostNetwork: true\n      shareProcessNamespace: true\n      _pad: "`
//     produced VALID YAML with `hostNetwork: true` on the POD — which defeats the
//     hardening block above it and, per N19 in network-policy.ts, voids BOTH
//     NetworkPolicy postures ("Neither GKE Dataplane V2 nor Calico enforce network
//     policies for Pods that use the spec.hostNetwork: true setting"), putting the pod on
//     the node network alongside the metadata server.
//   - routing-service-deployment.ts interpolates the quantity UNQUOTED (`cpu: ${cpuReq}`),
//     so it needs no quote-escaping at all: `250m\n              INJECTED: yes` injected a
//     sibling key on the first try.
// A deliberately narrow subset of the real quantity grammar (no exponent/`e` forms, no
// bare SI `k`/`M`): everything a pod spec needs, nothing that can carry a YAML breakout.
const QUANTITY_RE = /^[0-9]+(\.[0-9]+)?(m|[KMGTPE]i?)?$/;

export function assertSafeQuantity(value: string, field: string): void {
  if (typeof value !== "string" || !QUANTITY_RE.test(value)) {
    throw new Error(
      `Invalid Kubernetes quantity ${JSON.stringify(value)} for ${field}: must match ` +
        `${QUANTITY_RE} (e.g. "250m", "1", "1.5", "512Mi", "2Gi"). Resource quantities are ` +
        `interpolated into the rendered pod spec, so anything outside this charset is ` +
        `rejected rather than escaped.`,
    );
  }
}

// N85. `readinessProbe.httpGet.path: ${readinessPath}` (deployment.ts) is another BARE YAML
// scalar sink, and its value is no longer a constant: deploy snapshots the LIVE pod template's
// probe path so a retained previous build keeps a probe its pods can satisfy (N66), which means
// a cluster-sourced string reaches this interpolation. Same posture as the quantities above —
// a narrow charset, rejected rather than escaped. Absolute path, no whitespace, no YAML
// metacharacters; query strings are allowed because the pool matches on the parsed pathname.
const PROBE_PATH_RE = /^\/[A-Za-z0-9._~\-/]*(\?[A-Za-z0-9._~\-/=&%]*)?$/;

export function assertSafeProbePath(value: string, field: string): void {
  if (typeof value !== "string" || value.length > 256 || !PROBE_PATH_RE.test(value)) {
    throw new Error(
      `Invalid probe path ${JSON.stringify(value)} for ${field}: must match ${PROBE_PATH_RE} ` +
        `(e.g. "/readyz"). The path is interpolated into the rendered pod spec as a bare YAML ` +
        `scalar, so anything outside this charset is rejected rather than escaped.`,
    );
  }
}

// N60. Scaling knobs are interpolated as BARE YAML scalars — `minReplicas: {{ … }}`
// (hpa.ts, via values.yaml) and `minReplicas: ${minReplicas}` (routing-service-hpa.ts) —
// so a string carrying a newline injects a sibling key into the HPA spec exactly like the
// quantity sink above. Require a real integer in a sane range at every consumption point.
function assertSafeInteger(value: number, field: string, min: number, max: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `Invalid ${field}: expected an integer between ${min} and ${max}, got ` +
        `${JSON.stringify(value)}. Scaling values are interpolated into the rendered ` +
        `HorizontalPodAutoscaler/Deployment spec as bare YAML scalars.`,
    );
  }
}

export function assertSafeReplicaCount(value: number, field: string): void {
  assertSafeInteger(value, field, 0, 5000);
}

export function assertSafeTargetCPU(value: number, field: string): void {
  // HPA `averageUtilization` is a percentage of the pod's REQUESTED cpu, not of one core, so
  // values above 100 are valid and common (a pool that requests 250m and is happy running at
  // 500m targets 200). Capping at 100 rejected working configurations at chart-generation
  // time. The bound that matters here is only "a positive integer that cannot break out of
  // the bare YAML scalar it is interpolated into"; 10000 is a sanity ceiling, not an API one.
  assertSafeInteger(value, field, 1, 10_000);
}

// N61. Pool names are operator-supplied (`next.config` `pools` keys) and land in K8s
// LABEL VALUES (`app.kubernetes.io/component`), label SELECTORS, and an HTTPRoute header
// match value. Two failures the old `/^[a-z0-9-]+$/` allowed:
//   - Every YAML 1.1 boolean word (`on`, `no`, `y`, `off`, `true`) and bare integers.
//     Unquoted, `component: on` renders a YAML BOOLEAN; `helm template` accepts it (exit
//     0) and the apiserver then rejects the chart — verified:
//     `error: unable to decode …: json: cannot unmarshal bool into Go struct field
//     ObjectMeta.metadata.labels of type string` (sigs.k8s.io/yaml -> go-yaml v2). The
//     templates now QUOTE every interpolated pool name, which is the real fix; this
//     charset is the second line of defence.
//   - A leading/trailing hyphen, which is an invalid label value and an invalid DNS-1123
//     name component (`-api` / `api-`).
const POOL_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// The 63-char bound here is the DNS-1123 / label-value ceiling, NOT the name budget: the
// tighter 40-char cap (and the combined release+pool arithmetic) lives in validateConfig,
// whose error message spells out why. Keeping this one loose lets that message win.
export function assertSafePoolName(poolName: string): void {
  if (poolName.length > 63 || !POOL_NAME_RE.test(poolName)) {
    throw new Error(
      `Invalid pool name "${poolName}": must match ${POOL_NAME_RE} (lowercase letters, ` +
        `digits and hyphens; must start and end with a letter or digit), max 63 chars.`,
    );
  }
}
