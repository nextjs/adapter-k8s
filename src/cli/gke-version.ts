// src/cli/gke-version.ts
// GCPHTTPFilter (Cloud CDN for Gateway) requires this GKE version or later.
export const MIN_GKE_VERSION_FOR_CDN = "1.35.2-gke.1751000";

interface GkeVersion {
  major: number;
  minor: number;
  patch: number;
  build: number;
}

// Parses "1.35.2-gke.1751000" (a trailing suffix like "-rc1" is tolerated and ignored).
export function parseGkeVersion(version: string): GkeVersion | null {
  const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)-gke\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), build: Number(m[4]) };
}

// Returns null when either version is unparseable (caller decides how to treat unknown).
export function gkeVersionAtLeast(version: string, floor: string): boolean | null {
  const v = parseGkeVersion(version);
  const f = parseGkeVersion(floor);
  if (!v || !f) return null;
  for (const key of ["major", "minor", "patch", "build"] as const) {
    if (v[key] !== f[key]) return v[key] > f[key];
  }
  return true;
}
