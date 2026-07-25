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
 * Blue/green requires two builds' sanitized resource names to be disjoint PER
 * KIND: a shared same-kind name means the new Deployment/Service/HPA/
 * HealthCheckPolicy adopts or shadows the serving one mid-cutover. K8s name
 * uniqueness is per kind, so the comparison must be too — an earlier flat
 * cross-kind set false-positived on build ids like "foo" vs "foo-hpa" (build
 * "foo"'s HPA shares a NAME with build "foo-hpa"'s Deployment, but a Deployment
 * and an HPA with the same name coexist fine). Compare deployment-vs-deployment
 * (the versioned Service shares that name), hpa-vs-hpa, hcp-vs-hcp, and
 * snapshot-vs-snapshot. Returns the first same-kind colliding name plus its kind
 * (for the error message), or null when all names are distinct. Used by the
 * build-time guard in adapter.ts; the deploy-time guard (deploy.ts) uses the same
 * helper so both sides agree.
 */
export function findBuildIdNameCollision(
  releaseName: string,
  poolNames: string[],
  currentBuildId: string,
  previousBuildId: string,
): { kind: string; name: string } | null {
  const kinds = [
    ["deployment", "Deployment/Service"],
    ["hpa", "HorizontalPodAutoscaler"],
    ["hcp", "HealthCheckPolicy"],
  ] as const;
  for (const [key, kind] of kinds) {
    const previous = new Set(
      poolNames.map((pool) => poolResourceNames(releaseName, pool, previousBuildId)[key]),
    );
    for (const pool of poolNames) {
      const name = poolResourceNames(releaseName, pool, currentBuildId)[key];
      if (previous.has(name)) return { kind, name };
    }
  }
  // Snapshot names embed an 8-hex digest of the FULL build id, so distinct build
  // ids can't realistically collide here — kept for completeness (the digest IS
  // truncation-proof, but the guard should not silently assume that).
  const snapshot = routingManifestSnapshotName(releaseName, currentBuildId);
  if (snapshot === routingManifestSnapshotName(releaseName, previousBuildId)) {
    return { kind: "ConfigMap", name: snapshot };
  }
  return null;
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
const RELEASE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION_RE = /^[a-z0-9-]+$/;
// DNS-1123 hostname, optionally with a single left-most wildcard label (`*.example.com`).
// Lowercase only, no whitespace/quotes — safe to embed in a quoted YAML scalar.
const HOSTNAME_RE =
  /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
// OCI registry/repository prefix (no tag — the tag is the build id, applied separately).
// Lowercase alnum with `.`/`_`/`-` separators and `/` path segments.
const IMAGE_REGISTRY_RE = /^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/;
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

export function assertSafeImageRegistry(registry: string): void {
  if (registry.length > 255 || !IMAGE_REGISTRY_RE.test(registry)) {
    throw new Error(
      `Invalid image registry "${registry}": must be a lowercase registry/repository ` +
        `path (e.g. "us-central1-docker.pkg.dev/my-project/nextjs"), no tag or scheme.`,
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
