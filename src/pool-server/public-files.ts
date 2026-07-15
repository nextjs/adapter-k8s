// src/pool-server/public-files.ts
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

// @next/routing resolves rewrites against a filesystem pathname set. Next's
// adapter outputs don't enumerate files from public/, so without augmenting the
// set a valid rewrite such as `/files/:path* -> /:path*` is discarded before
// the pool's public-file fast path can serve its destination.
export function collectPublicPathnames(projectDir: string): string[] {
  const root = path.join(projectDir, "public");
  if (!existsSync(root)) return [];
  const pathnames: string[] = [];
  const visit = (dir: string, relativeDir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) visit(path.join(dir, entry.name), relative);
      else if (entry.isFile()) pathnames.push("/" + relative.split(path.sep).join("/"));
    }
  };
  visit(root, "");
  return pathnames.sort();
}
