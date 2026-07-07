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

// Values below are spliced into shell scripts and K8s resource names that run under
// privileged Workload-Identity service accounts. They are never validated elsewhere,
// so guard against injection / invalid-name errors at generation time.
const RELEASE_NAME_RE = /^[a-z0-9-]+$/;
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION_RE = /^[a-z0-9-]+$/;

export function assertSafeReleaseName(releaseName: string): void {
  if (!RELEASE_NAME_RE.test(releaseName)) {
    throw new Error(
      `Invalid releaseName "${releaseName}": must match ${RELEASE_NAME_RE} ` +
        `(lowercase letters, digits, and hyphens only).`,
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
