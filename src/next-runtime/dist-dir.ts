import path from "node:path";

export const DEFAULT_NEXT_DIST_DIR = ".next";

/**
 * Normalize the project-relative distDir carried by the routing manifest.
 *
 * The image always runs on Linux, so the manifest uses POSIX separators even when the build
 * host does not. Absolute and parent-traversing paths are refused because runtime consumers use
 * this value for filesystem reads and a Kubernetes volume mount.
 */
export function normalizeNextDistDir(value: unknown): string {
  const raw = value === undefined ? DEFAULT_NEXT_DIST_DIR : value;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("Next distDir must be a non-empty project-relative path");
  }
  if (raw.includes("\0") || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new Error(`Next distDir must be project-relative, got ${JSON.stringify(raw)}`);
  }
  const posix = raw.split(path.win32.sep).join(path.posix.sep);
  const normalized = path.posix.normalize(posix);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Next distDir must stay inside the project, got ${JSON.stringify(raw)}`);
  }
  return normalized;
}

export function resolveNextDistDir(
  projectDir: string,
  value: unknown,
): { relative: string; absolute: string } {
  const relative = normalizeNextDistDir(value);
  const absolute = path.resolve(projectDir, ...relative.split("/"));
  const root = path.resolve(projectDir);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error(`Next distDir must stay inside the project, got ${JSON.stringify(value)}`);
  }
  return { relative, absolute };
}
