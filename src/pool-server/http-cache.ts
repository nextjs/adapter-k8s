import { createHash } from "node:crypto";

export function staticAssetEtag(content: Buffer): string {
  // Strong content identity lets mutable static artifacts such as generated service workers use
  // `max-age=0, must-revalidate` without downloading an unchanged body on every update check.
  // Do not derive this from mtime: staged image layers can change timestamps without changing the
  // asset, while the bytes are the cache validator shared by every pool replica.
  return `"${createHash("sha1").update(content).digest("base64url")}"`;
}

export function ifNoneMatchMatches(value: string | undefined, etag: string): boolean {
  if (!value) return false;
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, "");
    return normalized === "*" || normalized === etag;
  });
}

