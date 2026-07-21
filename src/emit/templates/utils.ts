// src/emit/templates/utils.ts

export function sanitizeK8sName(name: string): string {
  // Lowercase, replace non-alphanumeric with hyphens
  let sanitized = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
  // Ensure it starts with a letter (prepend BEFORE truncation so the prefix survives)
  if (!/^[a-z]/.test(sanitized)) {
    sanitized = `b-${sanitized}`;
  }
  // Truncate to 63 characters (DNS-1035/1123 limit) FIRST — otherwise stripping
  // trailing hyphens before truncating lets the slice reintroduce one.
  sanitized = sanitized.slice(0, 63);
  // Strip leading/trailing hyphens so the name starts and ends alphanumeric.
  // The leading `b-` guarantees a surviving leading letter, so this never empties the string.
  sanitized = sanitized.replace(/^-+/, "").replace(/-+$/, "");
  return sanitized;
}

// Values below are spliced into shell scripts, `helm --set` assignments, K8s resource
// names, and YAML that runs under privileged Workload-Identity service accounts. Guard
// against injection / invalid-name errors at the boundary — never interpolate raw.
//
// releaseName is capped at 40 chars: it is prefixed into longer resource names
// (`${releaseName}-routing-service`, GKE cluster `${releaseName}-cluster`, etc.) that
// must each fit their own length limits (63 for K8s names, 40 for GKE clusters).
const RELEASE_NAME_RE = /^[a-z0-9-]{1,40}$/;
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
        `(lowercase letters, digits, and hyphens only, max 40 chars).`,
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
