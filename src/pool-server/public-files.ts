// src/pool-server/public-files.ts
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export function decodePublicPathname(pathname: string): string | null {
  try {
    // URL.pathname remains percent-encoded. Filesystem lookup must decode exactly once: an image
    // optimizer URL contains `/hello%20world.jpg` after its outer query decoding, and the staged
    // file is literally `public/hello world.jpg`. A second decode would corrupt literal `%20`
    // filenames; resolveWithinRoot remains responsible for rejecting decoded traversal.
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

// @next/routing resolves rewrites against a filesystem pathname set. Next's
// adapter outputs don't enumerate files from public/, so without augmenting the
// set a valid rewrite such as `/files/:path* -> /:path*` is discarded before
// the pool's public-file fast path can serve its destination.
// N50 (review, Low): `entry.isFile()` and `entry.isDirectory()` are BOTH false for a
// symlink (readdirSync does not follow links), so a symlinked entry under public/ was
// invisible to this enumeration. Consequences: the file 404s in production from the pool's
// fast path AND from Phase-2 dispatch (emit/static-assets.ts builds the manifest from this
// list), while `next start` serves it happily (`send` follows links) — a parity gap that
// only shows up after deploy. Resolve links with realpathSync/statSync and require the
// target to stay inside public/, so a link pointing outside (../.env, /etc/passwd) is
// skipped with a warning instead of being published.
// N50 (review, follow-up): containment alone does not make the walk finite. A symlink whose
// target is INSIDE public/ passes the containment check above and can still point at itself or
// at an ancestor — `public/loop -> .` and `public/a/up -> ..` are the two minimal cases — so the
// recursion re-enters the same real directory forever (`/loop/loop/loop/…`) until ENAMETOOLONG or
// a stack overflow aborts the build. `ancestorChain` carries the real path of every directory
// currently on the walk stack: an infinite descent must re-enter one of those (a strictly
// descending chain of DISTINCT real directories is finite on any filesystem), so refusing exactly
// that case is sufficient to terminate. Deliberately NOT a global visited-set: two sibling links
// into the same subtree (`x -> ./sub`, `y -> ./sub`) are legitimate and `next start` serves both
// prefixes, so a visited-set would silently drop the second one's files. A cycle is a repo
// mistake, not an attack, so it is skipped with a warning rather than thrown — failing the whole
// build would be harsher than `next start`, which just serves what it can reach.
export function collectPublicPathnames(projectDir: string): string[] {
  const root = path.join(projectDir, "public");
  if (!existsSync(root)) return [];
  const realRoot = realpathSync(root);
  const pathnames: string[] = [];
  const visit = (dir: string, relativeDir: string, ancestorChain: readonly string[]) => {
    const realDir = ancestorChain[ancestorChain.length - 1]!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const relative = path.join(relativeDir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      // For a real subdirectory this is exact: `realDir` is already resolved and `entry` is not
      // a link, so no component of the child path can be one either.
      let realChild = path.join(realDir, entry.name);
      if (entry.isSymbolicLink()) {
        let realTarget: string;
        try {
          realTarget = realpathSync(abs);
        } catch {
          continue; // dangling link — nothing to serve
        }
        if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
          console.warn(
            `[adapter-k8s] Skipping public/ symlink "${relative}": its target ` +
              `(${realTarget}) is outside public/. Serving it would publish a file from ` +
              `outside the public directory.`,
          );
          continue;
        }
        const stat = statSync(realTarget);
        isDirectory = stat.isDirectory();
        isFile = stat.isFile();
        realChild = realTarget;
      }
      if (isDirectory) {
        if (ancestorChain.includes(realChild)) {
          console.warn(
            `[adapter-k8s] Skipping cyclic public/ directory symlink "${relative}": its target ` +
              `(${realChild}) is the link's own directory or one of its ancestors, so following ` +
              `it would recurse forever. Files reachable without the cycle are still served.`,
          );
          continue;
        }
        visit(abs, relative, [...ancestorChain, realChild]);
      } else if (isFile) pathnames.push("/" + relative.split(path.sep).join("/"));
    }
  };
  visit(root, "", [realRoot]);
  // Default sort() is code-point order — keep it (NOT localeCompare): this list feeds the
  // emitted static-asset manifest, whose bytes ship inside the image, and ICU collation
  // differs between a small-icu and a full-icu Node (see emit/static-assets.ts N50).
  return pathnames.sort();
}
