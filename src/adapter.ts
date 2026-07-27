// src/adapter.ts
import { writeFile, mkdir, copyFile, cp, rm, realpath, readdir, lstat } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHmac, randomBytes } from "node:crypto";
import type {
  NextAdapter,
  K8sAdapterConfig,
  BuildCompleteContext,
  PoolDefinition,
} from "./types.js";

// Get current directory in a way that works in ESM and CJS bundle
const _dirname =
  typeof import.meta !== "undefined" && import.meta.url
    ? path.dirname(fileURLToPath(import.meta.url))
    : typeof __dirname !== "undefined"
      ? __dirname
      : process.cwd();

// Resolve a dependency's directory, preferring the ADAPTER package (where the dep is
// declared, e.g. @next/routing) over the app root. Strict package managers (pnpm) do not
// expose the adapter's transitive deps from the app root, so app-first resolution turns a
// valid install into "cannot find module". App-root is kept as a fallback for hoisted
// layouts (npm) and for a symlinked adapter checkout.
function resolveDepDir(dep: string, projectDir: string): string | undefined {
  const fromFiles = [
    path.join(_dirname, "index.js"), // adapter package (dist/)
    path.join(projectDir, "package.json"), // app root
  ];
  for (const fromFile of fromFiles) {
    try {
      return path.dirname(createRequire(fromFile).resolve(`${dep}/package.json`));
    } catch {
      // try the next resolution root
    }
  }
  return undefined;
}

// Whether the app defines EDGE middleware. A node-based incremental `cacheHandler` (the
// adapter's bundled zero-dep RESP2 client over node:net/node:tls) gets bundled by Turbopack
// INTO the edge middleware runtime, where it can't evaluate — so the adapter skips
// registering that handler when edge middleware is present. (The V2 `use cache` handler,
// registered via the global symbol at runtime, is unaffected either way and always shares
// `use cache` entries cross-replica.)
//
// N50 (review #34): this used to be a pure FILENAME test — any `middleware.ts` counted as
// edge. Next 16 decides by the file's declared runtime, not its name:
// `hasNodeMiddleware = staticInfo.runtime === 'nodejs' || isProxyFile(page)`
// (next/src/build/index.ts, ~:2656). So `middleware.ts` with `export const runtime =
// 'nodejs'` is NODE middleware and there is no edge bundle to poison — yet the old check
// skipped the cacheHandler anyway. Consequence for such an app with `cache.enabled`:
// ISR/PPR-shell revalidation silently stopped being cross-replica, nothing was logged, and
// build-metadata.json still said `cacheEnabled: true`, so deploy provisioned a Memorystore
// instance the incremental cache never used.
//
// modifyConfig runs BEFORE the build, so `functions-config-manifest.json` does not exist
// yet (and a previous build's copy may be stale) — read the runtime the same way the build
// does, from the source file's segment config. onBuildComplete re-derives this
// authoritatively from `outputs.middleware.runtime` and reports any disagreement.
// `proxy.ts` (always Node, `isProxyFile`) is not in the candidate list at all.
// Exported (with the staging helpers below) for hermetic unit tests — see
// tests/adapter-staging.test.ts.
const MIDDLEWARE_FILENAMES = [
  "middleware.ts",
  "middleware.js",
  "middleware.tsx",
  "middleware.jsx",
  "middleware.mjs",
] as const;

// `export const runtime = "nodejs"` / `export const runtime = 'edge'`, allowing `let`/`var`
// and an optional `as const`/type annotation. Matches how Next's static analysis reads the
// segment config; a value it cannot resolve statically is a build error upstream, so a
// source that does not match here has no explicit runtime and therefore uses the default
// (edge, for `middleware.*`).
//
// N50 (review follow-up): this pattern used to be run over RAW SOURCE, so a COMMENTED-OUT or
// quoted declaration read as active. That runs the wrong way for safety: default-edge middleware
// with `// export const runtime = "nodejs"` in it was reported as Node, so with `cache.enabled`
// the Node Valkey cache handler was registered into an EDGE build, where `node:net`/`node:tls`
// cannot resolve. So the scan runs over `scanSource()` output instead: comments blanked, and every
// string/template literal replaced by a `\uE000<index>\uE000` sentinel whose value is looked
// up separately — a declaration that only exists inside a literal is a single sentinel token and
// can no longer produce a match, while a real declaration's value is still read.
const RUNTIME_EXPORT_RE = /export\s+(?:const|let|var)\s+runtime\s*(?::[^=]*)?=\s*\uE000(\d+)\uE000/;

// U+E000 is a private-use codepoint: it has no meaning in JS source, and any occurrence in
// the input is neutralized below so it cannot forge a sentinel.
const LITERAL_SENTINEL = "\uE000";

/**
 * Keywords after which a `/` starts a REGEX literal rather than being a division operator. Needed
 * because the disambiguation rule is "previous significant token is not an operand", and a keyword
 * ends in identifier characters just like an operand does (`return /x/` vs `a /x/`).
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

interface ScannedSource {
  /** Comments blanked, each string/template literal replaced by `\uE000<index>\uE000`. */
  code: string;
  /** Literal values, indexed by the number inside the sentinel. */
  literals: string[];
}

/**
 * Blank comments and lift string/template literals out of a JS/TS source, so a textual scan of
 * the result cannot be fooled by code that is commented out or quoted. A full parse is overkill
 * for one segment-config lookup; what matters is that the stripper itself cannot be fooled, so it
 * is a character scanner (not a chain of regex replaces): a `//` inside a string, a `/*` inside a
 * template literal, a quote inside a regex literal, `${}` substitutions containing any of those,
 * and backslash escapes are all handled by the state machine rather than by pattern matching.
 *
 * Regex literals are recognized with the standard "previous significant token" heuristic (plus the
 * keyword set above) because distinguishing `/` as division from `/` as a regex needs parse
 * context. Same for JSX text in a `middleware.tsx` (an apostrophe in `<p>don't</p>` is not a
 * string quote). A misjudgement can only OVER-consume, so a swallowed declaration reads as "no
 * explicit runtime", which lands on the conservative EDGE answer — the safe direction for the
 * caller (edge means the Node cache handler is left out, which merely costs cross-replica ISR).
 */
function scanSource(raw: string): ScannedSource {
  // A literal sentinel codepoint in the source would forge a lifted literal; there is no legal
  // reason for one in JS source, so neutralize any before scanning.
  const src = raw.includes(LITERAL_SENTINEL) ? raw.split(LITERAL_SENTINEL).join(" ") : raw;
  const n = src.length;
  const literals: string[] = [];
  let code = "";
  let i = 0;

  const isIdentChar = (ch: string) => /[A-Za-z0-9_$]/.test(ch);

  const pushLiteral = (value: string) => {
    code += `${LITERAL_SENTINEL}${literals.length}${LITERAL_SENTINEL}`;
    literals.push(value);
  };

  /** Cursor is on the opening quote; consumes through the closing quote. */
  const scanQuoted = (quote: string): string => {
    let value = "";
    i++;
    while (i < n) {
      const ch = src[i]!;
      if (ch === "\\") {
        value += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) {
        i++;
        break;
      }
      // Unterminated string: a syntax error the build will report. Stop at the newline rather
      // than swallowing the rest of the file.
      if (ch === "\n") break;
      value += ch;
      i++;
    }
    return value;
  };

  /** Cursor is on the opening backtick; consumes through the closing backtick. */
  const scanTemplate = (): string => {
    let value = "";
    i++;
    while (i < n) {
      const ch = src[i]!;
      if (ch === "\\") {
        value += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === "`") {
        i++;
        break;
      }
      if (ch === "$" && src[i + 1] === "{") {
        i += 2;
        // Keep the marker in the value: a substituted template is not a statically resolvable
        // segment config, and `"${…}"` can never equal `"nodejs"`.
        value += "${}";
        skipBracedExpression();
        continue;
      }
      value += ch;
      i++;
    }
    return value;
  };

  /** Cursor is just past a `${`; consumes through the matching `}`. */
  const skipBracedExpression = (): void => {
    let depth = 1;
    while (i < n) {
      const ch = src[i]!;
      const next = src[i + 1];
      if (ch === "{") {
        depth++;
        i++;
      } else if (ch === "}") {
        i++;
        if (--depth === 0) return;
      } else if (ch === "/" && next === "/") {
        while (i < n && src[i] !== "\n") i++;
      } else if (ch === "/" && next === "*") {
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i += 2;
      } else if (ch === '"' || ch === "'") {
        scanQuoted(ch);
      } else if (ch === "`") {
        scanTemplate();
      } else {
        i++;
      }
    }
  };

  /** Cursor is on the leading `/` of a regex literal; consumes through the closing `/` + flags. */
  const skipRegex = (): void => {
    i++;
    let inClass = false;
    while (i < n) {
      const ch = src[i]!;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "\n") return; // unterminated — not actually a regex; let the build complain
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) {
        i++;
        while (i < n && isIdentChar(src[i]!)) i++; // flags
        return;
      }
      i++;
    }
  };

  /** True when a `/` at the cursor starts a regex literal rather than being division. */
  const regexCanStartHere = (): boolean => {
    const trimmed = code.trimEnd();
    if (trimmed.length === 0) return true;
    const prev = trimmed[trimmed.length - 1]!;
    if (prev === ")" || prev === "]" || prev === LITERAL_SENTINEL) return false;
    if (!isIdentChar(prev)) return true; // `=`, `(`, `,`, `:`, `{`, `}`, `;`, an operator, …
    const word = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(trimmed)?.[0] ?? "";
    return REGEX_PRECEDING_KEYWORDS.has(word);
  };

  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      code += " ";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      code += " "; // a space, not nothing: `export/**/const` must not become `exportconst`
    } else if (ch === '"' || ch === "'") {
      pushLiteral(scanQuoted(ch));
    } else if (ch === "`") {
      pushLiteral(scanTemplate());
    } else if (ch === "/" && regexCanStartHere()) {
      skipRegex();
      code += " 0"; // an operand, so a following `/` reads as division
    } else {
      code += ch;
      i++;
    }
  }
  return { code, literals };
}

export function findMiddlewareSource(projectDir: string): string | undefined {
  for (const dir of [projectDir, path.join(projectDir, "src")]) {
    for (const name of MIDDLEWARE_FILENAMES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function hasEdgeMiddleware(projectDir: string): boolean {
  const source = findMiddlewareSource(projectDir);
  if (!source) return false;
  let contents = "";
  try {
    contents = readFileSync(source, "utf-8");
  } catch {
    // Unreadable middleware source: fall back to the conservative answer (treat as edge,
    // i.e. skip the handler) — the build itself will fail on the same file momentarily.
    return true;
  }
  const { code, literals } = scanSource(contents);
  const match = RUNTIME_EXPORT_RE.exec(code);
  // Only a string/template LITERAL is a statically resolvable runtime (`runtime = RUNTIME_CONST`
  // is a build error upstream), so a non-match means "no explicit runtime" → the default, edge.
  const declared = match ? literals[Number(match[1])] : undefined;
  return declared !== "nodejs";
}

import { validateConfig, applyDefaults } from "./config.js";
import { classifyIntoPools } from "./classify.js";
import { buildRoutingManifest } from "./manifest.js";
import { generateHelmChart, SECRET_CHART_FILES } from "./emit/helm.js";
import {
  assertProbePathsUnowned,
  assertSafeBuildId,
  assertSafeImageRegistry,
  assertSafeNamespace,
  assertSafeProjectId,
  assertSafeRegion,
  findBuildIdNameCollision,
  findEmittedNameCollision,
  K8S_NAMESPACE,
} from "./emit/templates/utils.js";
import {
  generateDockerfile,
  generatePoolDockerfile,
  generateRoutingServiceDockerfile,
} from "./emit/dockerfiles.js";
import { generateBuildMetadata } from "./emit/metadata.js";
import { generateDockerignore } from "./emit/dockerignore.js";
import { buildStaticManifest } from "./emit/static-assets.js";
import { collectPublicPathnames } from "./pool-server/public-files.js";
import { generateCelExpression } from "./cel.js";
import { generateExtensionChain, determineFailureMode } from "./extension-chain.js";

// Output directory matches §18.3 in the design doc
const OUTPUT_DIR = ".k8s-adapter/output";

// Where the adapter's esbuild bundles (pool-server.cjs, routing-service.cjs,
// cache-handler.cjs) live — next to this module in the published package's dist/.
// ADAPTER_K8S_BUNDLE_DIR overrides it for tests and for running the adapter straight from
// a source checkout, where the bundles sit in dist/ rather than beside adapter.ts.
function bundleDir(): string {
  return process.env.ADAPTER_K8S_BUNDLE_DIR || _dirname;
}

// N50 (review #29). These three bundles used to be read through
// `existsSync(src) ? readFileSync(src) : ""` followed by `if (content) write`. A missing
// bundle (a partial `npm run build`, a renamed esbuild output, a botched package) therefore
// staged a build context whose Dockerfile still `CMD`s the missing file: the image built and
// pushed cleanly and then CrashLoopBackOff'd, with ZERO build-time signal. For the cache
// handler it was worse — `next.config.cacheHandler` was silently dropped, so ISR/PPR-shell
// revalidation stopped being cross-replica while build-metadata still claimed the cache was
// enabled. Lines further down (@next/routing) show this class was already decided: throw.
export function adapterBundlePath(name: string): string {
  const src = path.join(bundleDir(), name);
  if (!existsSync(src)) {
    throw new Error(
      `[adapter-k8s] Missing adapter runtime bundle: ${src}. The emitted image's ` +
        `Dockerfile runs it, so a build without it would push an image that ` +
        `CrashLoopBackOffs with "Cannot find module". Run \`npm run build\` in the adapter ` +
        `package (or reinstall @next-community/adapter-k8s) and rebuild.`,
    );
  }
  return src;
}

export function readAdapterBundle(name: string): string {
  return readFileSync(adapterBundlePath(name), "utf-8");
}

// A Docker tag must match `[\w][\w.-]*` — BUILD_ID_RE (assertSafeBuildId) permits
// `[A-Za-z0-9._-]`, i.e. it accepts ids starting with `.` or `-`, which `docker build -t`
// rejects with "invalid reference format" AFTER a full build. N50 (review #22): with the
// dead build-id generator, ~1 nanoid in 64 started with `-`. Assert the tag charset at the
// same place the build id is validated, so the failure is a build-time message rather than a
// docker error at push time.
export function assertDockerTagSafeBuildId(buildId: string): void {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(buildId)) {
    throw new Error(
      `[adapter-k8s] buildId "${buildId}" cannot be used as a Docker image tag: a tag must ` +
        `match [A-Za-z0-9_][A-Za-z0-9._-]* (it may not start with "." or "-"). The build id ` +
        `is the image tag for every pool image and the routing service. Set generateBuildId ` +
        `in next.config to something that starts with a letter, digit or underscore.`,
    );
  }
}

// N50 (review, Medium): three call sites used a bare `JSON.parse(readFileSync(...))` on
// operator-editable JSON (.k8s-adapter/infrastructure.json, state.json). A hand-edited
// trailing comma surfaced as `SyntaxError: Unexpected token } in JSON at position 214` with
// no filename — and a comment in ensureConfig claimed "onBuildComplete reads the same file
// and surfaces the parse error with context", which it did not do. It does now.
function readJsonFile(filePath: string, label: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `[adapter-k8s] Could not read ${label} (${filePath}): ${(err as Error).message}`,
    );
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `[adapter-k8s] ${label} is not valid JSON (${filePath}): ${(err as Error).message}. ` +
        `Fix the file, or delete it to regenerate (\`npx adapter-k8s init\` for ` +
        `infrastructure.json).`,
    );
  }
}

async function writeOutputFile(
  projectDir: string,
  relativePath: string,
  content: string,
  baseDir: string = OUTPUT_DIR,
  mode?: number,
): Promise<void> {
  const fullPath = path.join(projectDir, baseDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
}

// Resolve and copy .next/node_modules/ — Turbopack creates symlinks to
// real node_modules packages. Docker COPY doesn't follow symlinks outside
// the build context, so we resolve each symlink and copy the real content.
export async function resolveAndCopyExternals(src: string, dest: string): Promise<void> {
  if (!existsSync(src)) return;
  // Always rebuild — previous builds may have left stale symlinks
  if (existsSync(dest)) await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  const entries = await readdir(src);

  for (const entry of entries) {
    const srcEntry = path.join(src, entry);
    const destEntry = path.join(dest, entry);
    const stat = await lstat(srcEntry);

    if (stat.isSymbolicLink()) {
      // Resolve the symlink to its real target and copy the content.
      // N50 (review, Medium): this was a bare `await realpath(...)`, which REJECTS for a
      // dangling link — so a stale `.next/node_modules` entry (a package removed from
      // node_modules after the last build, or a pruned pnpm store) aborted `next build`
      // with an unattributed `ENOENT: no such file or directory, realpath '...'`, and the
      // `existsSync(realTarget)` guard below it was dead code (unreachable). Catch, then
      // fail with the entry name and the fix.
      const realTarget = await realpath(srcEntry).catch(() => null);
      if (realTarget === null || !existsSync(realTarget)) {
        throw new Error(
          `[adapter-k8s] Dangling symlink in the Turbopack externals directory: ` +
            `${srcEntry} does not resolve to an existing target. This usually means ` +
            `node_modules changed after the last build (a removed/upgraded package, a ` +
            `pruned pnpm store, or a switched branch) and ${path.dirname(src)} is stale. ` +
            `Delete the dist directory and re-run \`next build\`.`,
        );
      }
      const targetStat = statSync(realTarget);
      if (targetStat.isDirectory()) {
        await cp(realTarget, destEntry, { recursive: true, dereference: true });
      } else {
        await copyFile(realTarget, destEntry);
      }
    } else if (stat.isDirectory()) {
      // Recurse into scoped package directories (e.g., @opentelemetry/)
      await resolveAndCopyExternals(srcEntry, destEntry);
    } else {
      await copyFile(srcEntry, destEntry);
    }
  }
}

// Traced-asset keys are relative to ctx.repoRoot (the tracing root), which differs from
// ctx.projectDir in a monorepo/workspace. Entrypoints are staged relative to projectDir,
// so an asset that lives *under* projectDir must be re-based to a projectDir-relative
// destination — otherwise Node's upward node_modules walk from the (projectDir-relative)
// entrypoint can't reach it. Assets outside projectDir but INSIDE repoRoot (hoisted to
// repoRoot/node_modules, which is already the common layout) keep their repoRoot-relative
// key, which lands them where the upward walk expects. Sibling-workspace-package assets
// remain a known gap (warned about at build time). When repoRoot === projectDir this is a
// no-op.
//
// N50 (review #9, reproduced). Next keys traced assets as `path.relative(repoRoot, file)`,
// so a traced file ABOVE the lockfile-detected root yields a `../`-prefixed key — real
// triggers: a `file:`/`link:` dependency, a linked `next` checkout, a pnpm store outside the
// tree, a narrow `outputFileTracingRoot`. This function returned that key verbatim and
// `stageFile` did a bare `path.join(stageDir, key)`, with two observed outcomes:
//   (a) the asset lands OUTSIDE `context/`, so `COPY context/ .` misses it and the image
//       silently lacks a runtime dependency (exactly the sharp-incident shape); and
//   (b) with enough `../` segments, `cp -r` OVERWRITES FILES IN THE REPO. Measured:
//       stageFile(projectDir, evil, "../../../../../../package.json") replaced
//       `<repo>/package.json` with the source file's contents.
// Escaping keys are now rebased into a synthetic in-context path (never `..`), and
// stageFile asserts containment as a backstop.
const EXTERNAL_ASSET_DIR = ".adapter-k8s-external";
const rebasedAssetWarnings = new Set<string>();

function escapesContext(relPath: string): boolean {
  const normalized = path.normalize(relPath);
  return (
    path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(".." + path.sep)
  );
}

export function assetDestPath(
  projectDir: string,
  repoRootRelativeKey: string,
  absAsset: string,
): string {
  const abs = path.isAbsolute(absAsset) ? absAsset : path.resolve(projectDir, absAsset);
  if (abs === projectDir || abs.startsWith(projectDir + path.sep)) {
    return path.relative(projectDir, abs);
  }
  if (!escapesContext(repoRootRelativeKey)) return path.normalize(repoRootRelativeKey);

  // The key escapes the build context. Rebase it into a path that stays inside:
  //   - anything under a `node_modules/` segment is re-rooted at the LAST such segment, so
  //     `../../pnpm-store/v3/node_modules/foo/index.js` → `node_modules/foo/index.js` and
  //     Node's upward walk from the staged entrypoint still resolves it;
  //   - anything else is flattened under `.adapter-k8s-external/`, which at least ships the
  //     bytes inside the image instead of silently dropping them (or clobbering the repo).
  const segments = path.normalize(repoRootRelativeKey).split(path.sep);
  const lastNodeModules = segments.lastIndexOf("node_modules");
  const rebased =
    lastNodeModules === -1
      ? path.join(
          EXTERNAL_ASSET_DIR,
          ...segments.filter((s) => s !== ".." && s !== "." && s !== ""),
        )
      : path.join(...segments.slice(lastNodeModules));
  if (!rebasedAssetWarnings.has(repoRootRelativeKey)) {
    rebasedAssetWarnings.add(repoRootRelativeKey);
    console.warn(
      `[adapter-k8s] Traced asset "${repoRootRelativeKey}" resolves ABOVE the tracing root ` +
        `(${absAsset}) — staging it as "${rebased}" so it stays inside the Docker build ` +
        `context. Runtime resolution is not guaranteed for such assets: prefer hoisting the ` +
        `dependency into the app's node_modules, or widen outputFileTracingRoot.`,
    );
  }
  return rebased;
}

// Track staged paths per build to avoid redundant work and loops
export const stagedPaths = new Set<string>();

// N50 (review, Medium): copy failures used to be swallowed as a `console.warn` buried in
// `next build` output — an EACCES/ENOSPC mid-copy shipped an image missing a page handler
// with an exit code of 0. Failures are collected here and thrown as a group at the end of
// onBuildComplete, so the build fails with the full list instead of one line per file.
export const stagingFailures: Array<{ source: string; dest: string; message: string }> = [];

export function assertNoStagingFailures(): void {
  if (stagingFailures.length === 0) return;
  const details = stagingFailures
    .map(({ source, dest, message }) => `  - ${source} -> ${dest}: ${message}`)
    .join("\n");
  const count = stagingFailures.length;
  stagingFailures.length = 0;
  throw new Error(
    `[adapter-k8s] ${count} file(s) could not be staged into the Docker build context(s). ` +
      `The emitted image would be missing them at runtime (module-not-found / 404 per route), ` +
      `so the build fails here instead:\n${details}`,
  );
}

// The staged destination must stay inside the build context. See the N50 note on
// assetDestPath: without this assertion a `../`-prefixed traced-asset key either put the
// file outside `context/` (silently absent from the image) or overwrote repo files.
export function assertStagedWithin(stageDir: string, absDest: string, destRelativePath: string) {
  if (absDest !== stageDir && !absDest.startsWith(stageDir + path.sep)) {
    throw new Error(
      `[adapter-k8s] Refusing to stage outside the Docker build context: ` +
        `"${destRelativePath}" resolves to ${absDest}, which is not under ${stageDir}. ` +
        `A traced-asset key containing ".." (a dependency above the tracing root — a ` +
        `file:/link: dependency, a pnpm store outside the tree, or a narrow ` +
        `outputFileTracingRoot) would either be missing from the image or overwrite files ` +
        `in your repository. Hoist the dependency into the app's node_modules, or widen ` +
        `outputFileTracingRoot so the asset is traced under the root.`,
    );
  }
}

export async function stageFile(
  projectDir: string,
  sourcePath: string,
  destRelativePath: string,
  poolName: string,
  isShared: boolean = false,
): Promise<void> {
  const absSource = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(projectDir, sourcePath);

  const stageDir = isShared
    ? path.join(projectDir, OUTPUT_DIR, "shared-context")
    : path.join(projectDir, OUTPUT_DIR, "pools", poolName, "context");

  // path.join normalizes, so `..` segments are resolved here — assert containment on the
  // RESULT (a `../`-keyed asset throws rather than escaping).
  const absDest = path.join(stageDir, destRelativePath);
  assertStagedWithin(stageDir, absDest, destRelativePath);

  if (stagedPaths.has(absDest)) return;
  if (!existsSync(absSource)) return;

  const realSource = await realpath(absSource).catch(() => absSource);
  // If destination already exists, check if it's the same as source
  if (existsSync(absDest)) {
    const realDest = await realpath(absDest).catch(() => absDest);
    if (realSource === realDest) return;
  }

  // Final guard: ensure dest is not inside source (prevents ERR_FS_CP_EINVAL)
  if (absDest.startsWith(realSource + path.sep) || absDest === realSource) {
    return;
  }

  try {
    await mkdir(path.dirname(absDest), { recursive: true });

    const sourceStat = statSync(absSource);
    if (sourceStat.isDirectory()) {
      // dereference: true is required to pull in symlinked node_modules content
      await cp(absSource, absDest, { recursive: true, dereference: true });
    } else {
      await copyFile(absSource, absDest);
    }
    // Mark done only AFTER a successful copy. Marking it up front meant a FAILED
    // destination was permanently recorded as staged, so a later call for the same dest
    // (from a different source, e.g. the same chunk reached via another output) was skipped
    // and the file never made it into the image.
    stagedPaths.add(absDest);
  } catch (err) {
    stagingFailures.push({
      source: sourcePath,
      dest: destRelativePath,
      message: (err as Error).message,
    });
  }
}

// Sharp's native runtime packages for the emitted pool container platform: the pool
// base image is node:*-slim (linux glibc) and GKE's default node pools are amd64, so
// the container needs the linux-x64 pair. esbuild inlines sharp's JS into
// pool-server.cjs, but the binding stays a RUNTIME require
// (`@img/sharp-linux-x64/sharp.node`, which in turn dlopens libvips from
// `@img/sharp-libvips-linux-x64`). Build XchOtaGFu6GdFrcdujVc0 shipped without either
// — every containerized /_next/image failed the sharp load (503 "sharp is
// unavailable") while local runs resolved the binding by walking up to the repo's own
// node_modules, which masked the gap.
export const SHARP_RUNTIME_PACKAGES = [
  "@img/sharp-linux-x64",
  "@img/sharp-libvips-linux-x64",
] as const;

// Resolver for sharp and its platform packages. resolveDepDir asks for
// `${dep}/package.json`, which the @img/* packages BLOCK via their exports maps
// (they export "./package", not "./package.json") — ERR_PACKAGE_PATH_NOT_EXPORTED
// would silently skip staging on every build. Resolve the exported "./package"
// subpath instead (sharp itself exports both), adapter-first like resolveDepDir.
// Falls back to the sibling layout next to the resolved sharp package: npm hoists
// @img/* beside sharp, and pnpm links a package's deps as virtual-store siblings.
export function resolveSharpDepDir(dep: string, projectDir: string): string | undefined {
  const fromFiles = [
    path.join(_dirname, "index.js"), // adapter package (dist/)
    path.join(projectDir, "package.json"), // app root
  ];
  for (const fromFile of fromFiles) {
    try {
      return path.dirname(createRequire(fromFile).resolve(`${dep}/package`));
    } catch {
      // try the next resolution root
    }
  }
  if (dep !== "sharp") {
    // Check the sibling of EVERY resolvable sharp copy — the adapter-first copy may
    // simply not have this platform package installed while the app root's does.
    for (const fromFile of fromFiles) {
      try {
        const sharpDir = path.dirname(createRequire(fromFile).resolve("sharp/package"));
        const sibling = path.join(sharpDir, "..", ...dep.split("/"));
        if (existsSync(path.join(sibling, "package.json"))) return sibling;
      } catch {
        // try the next resolution root
      }
    }
  }
  return undefined;
}

// Stage sharp's linux-x64 native packages into the pool's traced-assets context.
// npm installs platform-specific optional packages for the BUILD host only, so a
// darwin/arm64 host won't have the linux-x64 pair at all — in that case fall back to
// reporting the app's resolved sharp version so the caller can emit an npm-install
// step into the pool Dockerfile (running inside the image resolves the correct
// platform packages natively). `staged: false` with no version means sharp is not
// resolvable at all; image optimization will be unavailable in the container.
export async function stageSharpRuntimePackages(
  projectDir: string,
  poolName: string,
  resolveDep: (dep: string, projectDir: string) => string | undefined = resolveSharpDepDir,
  isShared: boolean = false,
): Promise<{ staged: boolean; sharpVersion?: string }> {
  const resolved = SHARP_RUNTIME_PACKAGES.map((pkg) => ({ pkg, dir: resolveDep(pkg, projectDir) }));
  if (resolved.every(({ dir }) => dir !== undefined && existsSync(dir))) {
    for (const { pkg, dir } of resolved) {
      await stageFile(projectDir, dir!, `node_modules/${pkg}`, poolName, isShared);
    }
    return { staged: true };
  }
  const sharpDir = resolveDep("sharp", projectDir);
  const sharpPkgJson = sharpDir ? path.join(sharpDir, "package.json") : undefined;
  if (sharpPkgJson && existsSync(sharpPkgJson)) {
    try {
      const version = (JSON.parse(readFileSync(sharpPkgJson, "utf-8")) as { version?: unknown })
        .version;
      if (typeof version === "string" && version.length > 0) {
        return { staged: false, sharpVersion: version };
      }
    } catch {
      // Unreadable/corrupt sharp package.json — fall through to the warning below.
    }
  }
  console.warn(
    `[adapter-k8s] Could not resolve sharp's linux-x64 runtime packages ` +
      `(${SHARP_RUNTIME_PACKAGES.join(", ")}) or a local sharp install — ` +
      `/_next/image optimization will be UNAVAILABLE (503) in the "${poolName}" pool container.`,
  );
  return { staged: false };
}

// releaseName comes from infrastructure.json (written by init, so it matches the gcloud
// resource names — IP, gateway, etc.) with a project-dir-basename fallback. The fallback
// is capped at 40 chars to mirror assertSafeReleaseName's limit — an over-long directory
// basename otherwise flows into template rendering and fails there with a far less
// actionable error. An all-symbols basename sanitizes to "" — fall back to "nextjs"
// (the `??` on infra.releaseName used to be dead: .replace() never yields null/undefined).
function deriveReleaseName(projectDir: string): string {
  const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
  const infra = existsSync(infraPath)
    ? (readJsonFile(infraPath, "infrastructure.json") as { releaseName?: string })
    : {};
  return (
    infra.releaseName ??
    (path
      .basename(projectDir)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      // Cap BEFORE stripping edge hyphens — the slice can land on one.
      .slice(0, 40)
      .replace(/^-+|-+$/g, "") ||
      "nextjs")
  );
}

// Internal dispatch secret (routing service ↔ pools). N50 (review #20): emit.helm.ts used
// to mint `randomBytes(32)` on every render because nothing passed a value, so re-emitting
// the chart for an unchanged build rotated the secret. That is not cosmetic: the new Secret
// applies immediately while the CURRENTLY-SERVING pods keep the old value, so for the whole
// rollout window they reject the routing service's dispatch headers and fall back to local
// resolution — middleware runs TWICE per request (rate limits, analytics). It also made
// invariant 5 unauditable (you cannot diff a regenerated chart against what was applied).
//
// Derivation: HMAC-SHA256(operatorKey, "<releaseName>\0<buildId>"). Same build ⇒ same
// secret, forever; different builds ⇒ unrelated secrets; and the value is never guessable
// from public inputs, because the key is operator-held:
//   1. ADAPTER_K8S_INTERNAL_SECRET_KEY (CI: keep it in the CI secret store), else
//   2. .k8s-adapter/internal-secret.key — created here on first build with 32 random bytes,
//      mode 0600, in the already-gitignored state dir (same convention as the other
//      secret-bearing files).
// A build cannot read the cluster (the other option the review floated), so the key file is
// what makes the derivation stable across re-emits on the same machine/checkout.
export async function deriveInternalSecret(
  projectDir: string,
  releaseName: string,
  buildId: string,
): Promise<string> {
  const envKey = process.env.ADAPTER_K8S_INTERNAL_SECRET_KEY;
  let key: string | undefined = envKey && envKey.length > 0 ? envKey : undefined;
  if (key === undefined) {
    const keyPath = path.join(projectDir, ".k8s-adapter", "internal-secret.key");
    if (existsSync(keyPath)) {
      key = readFileSync(keyPath, "utf-8").trim();
    }
    if (key === undefined || key.length === 0) {
      key = randomBytes(32).toString("hex");
      await mkdir(path.dirname(keyPath), { recursive: true });
      await writeFile(keyPath, key, { encoding: "utf-8", mode: 0o600 });
    }
  }
  return createHmac("sha256", key).update(`${releaseName}\0${buildId}`).digest("hex");
}

export function createK8sAdapter(userConfig?: K8sAdapterConfig): NextAdapter {
  let config: K8sAdapterConfig | undefined = userConfig;
  let configNormalized = false;

  async function ensureConfig(projectDir: string) {
    if (!config) {
      // Try to load from project root
      const configPaths = [
        path.join(projectDir, "adapter.config.mjs"),
        path.join(projectDir, "adapter.config.ts"),
        path.join(projectDir, "adapter.config.js"),
      ];

      for (const p of configPaths) {
        if (existsSync(p)) {
          try {
            const mod = await import(pathToFileURL(p).href);
            const exported = mod.default;
            if (exported && typeof exported === "object") {
              config = exported.config || exported;
              break;
            }
            console.warn(
              `[adapter-k8s] ${p} loaded but has no usable default export (expected an object ` +
                `or a createK8sAdapter() instance); ignoring it.`,
            );
          } catch (err) {
            console.error(`Failed to load config from ${p}:`, err);
          }
        }
      }

      if (!config) {
        console.log("[adapter-k8s] No adapter config found, using defaults");
        config = {
          pools: {
            default: { routes: ["appPages", "appRoutes", "pagesApi", "pages"] },
          },
          provider: {
            gke: {
              gateway: {
                type: "gateway-api",
                className: "gke-l7-global-external-managed",
                hosts: [{ hostname: "localhost", tls: { enabled: false } }],
              },
            },
          },
        };
      }
    }

    if (!configNormalized) {
      // Pass the release name (when derivable) so validateConfig can enforce the
      // COMBINED release+pool length budget — the per-field 40-char caps alone
      // permit composed resource names whose build id truncates away entirely.
      let releaseNameForBudget: string | undefined;
      try {
        releaseNameForBudget = deriveReleaseName(projectDir);
      } catch {
        // Corrupt infrastructure.json — skip the combined check here. onBuildComplete reads
        // the same file through readJsonFile, which names the file and the fix (N50: the
        // comment used to claim that and both readers were bare `JSON.parse`).
      }
      validateConfig(config, releaseNameForBudget);
      config = applyDefaults(config);
      configNormalized = true;
    }
    return config;
  }

  const adapter: NextAdapter = {
    name: "k8s",

    async modifyConfig(nextConfig, ctx) {
      // The stable adapter API ctx has { phase, nextVersion } — no projectDir.
      // Use process.cwd() which is the project root during build.
      const cfg = await ensureConfig(process.cwd());

      // N14: `deploymentId` (Next's skew protection) makes Next return a CONSTANT build id
      // — literally `build-TfctsWXpff2fKS` for every build, forever (see getBuildId in
      // next/src/build/index.ts: with skew protection the deployment-id header identifies
      // the version instead). This adapter keys blue/green on the build id: Deployment /
      // Service / HPA / HealthCheckPolicy names, the routing-manifest snapshot, the
      // adapter-k8s.dev/build-id label, and the CDN cutover cache-tag. A constant build id
      // makes consecutive deploys share every one of those names, so a "new" build would
      // adopt the serving Deployment mid-cutover instead of standing up beside it. The
      // composed-name collision guard in onBuildComplete would abort the deploy anyway;
      // fail here instead, at the point where the cause is visible and fixable.
      // WARN, don't throw: a build is not a deploy. The Next.js e2e deploy harness sets
      // NEXT_DEPLOYMENT_ID (→ config.deploymentId) on purpose to exercise `?dpl=` asset
      // versioning, and it never runs `adapter-k8s deploy` — it drives the pool server
      // directly, where a constant build id is harmless. The hazard is real only at CUTOVER,
      // so `adapter-k8s deploy` refuses it there (see the build-id collision guard in
      // src/cli/deploy.ts, which aborts on identical composed names).
      if ((nextConfig as { deploymentId?: string }).deploymentId) {
        console.warn(
          "[adapter-k8s] next.config `deploymentId` is set — you almost certainly do not need " +
            "it here, and it breaks blue/green. Next pins the build id to a CONSTANT when " +
            "deploymentId is set (getBuildId in next/src/build/index.ts), and this adapter " +
            "derives every blue/green resource name, the build-id label, the CDN cutover " +
            "cache-tag, AND the Valkey cache namespace (`k8s:<buildId>:`) from the build id — " +
            "so consecutive deploys would collide and even share cache entries. " +
            "`adapter-k8s deploy` refuses the cutover. You lose nothing by removing it: skew " +
            "protection is ALREADY active via the per-build build id (the RSC payload carries " +
            "it and the client hard-reloads on mismatch — see fetch-server-response.ts; " +
            "deploymentId only substitutes a different token for that same check), and " +
            "`?dpl=` asset versioning is moot because this adapter enables immutable " +
            "(content-addressed) assets, which suppress it.",
        );
      }

      const modified: Record<string, unknown> = {
        ...nextConfig,
        compress: false,
        // Set turbopack root to the project directory to avoid workspace detection issues
        // when the adapter is loaded from outside the project tree (e.g., e2e tests)
        turbopack: {
          ...(nextConfig as any).turbopack,
          root: (nextConfig as any).turbopack?.root ?? process.cwd(),
        },
        // Generate K8s-friendly build ids: `b` + base36 timestamp + base36 random, i.e.
        // lowercase alphanumeric only — safe as a Docker tag, a DNS-1123 name fragment, and
        // a label value.
        //
        // N50 (review #22): this used to be `nextConfig.generateBuildId ?? (() => …)`, which
        // NEVER fell through. Next's *default* config value for `generateBuildId` is a
        // FUNCTION — `generateBuildId: () => null` (next/src/server/config-shared.ts) — so
        // `??` always took the user branch, Next's `generateBuildId(fn, nanoid)` saw the
        // null, and the build id was a raw 21-char nanoid. Proof: the committed fixture
        // output carries `buildId: z84KgootQN1WpGZR3aUBj`, and no fixture sets
        // generateBuildId. nanoid's alphabet includes `A-Z`, `_` and `-`, and this id is the
        // DOCKER IMAGE TAG: a tag must match `[\w][\w.-]*`, so roughly 1 build in 64 (2 of
        // nanoid's 64 alphabet symbols) started with `-` and failed `docker build` with
        // "invalid reference format" AFTER the whole build. Test the type, call the user's
        // function, and fall back to our generator when it declines (returns null/undefined,
        // which is precisely what the default does).
        generateBuildId: async () => {
          const userGenerate = nextConfig.generateBuildId;
          if (typeof userGenerate === "function") {
            const userId = await userGenerate();
            if (typeof userId === "string" && userId.length > 0) return userId;
          }
          const timestamp = Date.now().toString(36);
          const random = Math.random().toString(36).slice(2, 8);
          return `b${timestamp}${random}`;
        },
      };

      // Opt into immutable static assets (Turbopack-only). Next then content-addresses immutable
      // assets and drops the `?dpl` skew token from their URLs (mutable assets like service workers
      // keep it), and the adapter serves them per Next's own header policy (see static-asset-headers).
      // Respect an explicit user opt-out.
      //
      // DELIBERATELY FORWARD-LOOKING, and a silent no-op below Next 16.3.
      // `experimental.supportsImmutableAssets` is the 16.3 key; it does not exist in 16.2.10's config
      // schema, where the equivalent knob is `experimental.immutableAssetToken` — a string that
      // SUPPLIES a `?dpl=` token, i.e. the INVERSE intent, and which 16.3.0-canary removes again.
      // So we set the 16.3 key unconditionally and do NOT backport the 16.2 one:
      //   * on 16.3 this is correct (content-addressed assets, `?dpl=` suppressed);
      //   * on 16.2 Next ignores the unknown key without warning and emits no
      //     `/_next/static/immutable/` directory — harmless, because with no `deploymentId`
      //     configured the `?dpl=` suffix is empty there anyway (build/define-env.js:89);
      //   * setting `immutableAssetToken` on 16.2 would ADD the token we do not want, and would be
      //     dead config the moment 16.3 lands.
      // Do NOT, however, reason from "this adapter enables immutable assets" when explaining 16.2
      // behaviour — below 16.3 it enables nothing. What actually versions asset URLs on both is
      // Turbopack's content-derived chunk naming (measured: a one-line client-component change moved
      // `07-7zvnown312.js` → `3v9mo0_pueesb.js`), which is also why no `?dpl=` token is needed.
      // See docs/superpowers/specs/2026-07-26-phase7-skew-protection.md (version-support policy).
      {
        const userImmutable = (
          nextConfig.experimental as { supportsImmutableAssets?: boolean } | undefined
        )?.supportsImmutableAssets;
        // ADAPTER_K8S_DISABLE_IMMUTABLE_ASSETS=1 forces it off — used to A/B whether the immutable
        // asset split regresses client bootstrap (asset URLs move under /_next/static/immutable/).
        const disabled = process.env.ADAPTER_K8S_DISABLE_IMMUTABLE_ASSETS === "1";
        modified.experimental = {
          ...((modified.experimental as Record<string, unknown>) ?? {}),
          supportsImmutableAssets: disabled ? false : (userImmutable ?? true),
        };
      }

      // Local build profile: cap workers and memory for constrained environments
      // (e2e tests, local emulation). Set ADAPTER_K8S_BUILD_CPUS to activate.
      const buildCpus = parseInt(process.env.ADAPTER_K8S_BUILD_CPUS ?? "", 10);
      if (buildCpus > 0) {
        modified.experimental = {
          ...((modified.experimental as Record<string, unknown>) ?? {}),
          cpus: buildCpus,
          memoryBasedWorkersCount: false,
          parallelServerCompiles: false,
          parallelServerBuildTraces: false,
          webpackBuildWorker: false,
        };
      }

      // Register the Valkey-backed incremental cache handler when the cache is enabled. The
      // bundled module (shipped in the adapter's dist) is copied to a build-surviving path and set
      // as `next.config.cacheHandler`. It falls back to Next's file-system cache when VALKEY_URL is
      // absent — so it is inert during `next build` and local runs, and only backs the incremental
      // cache (PPR shells + ISR pages) with Valkey at runtime in the pool, where VALKEY_URL +
      // NEXT_BUILD_ID are injected. Sharing this store is what makes those revalidate cross-replica.
      if (cfg.cache?.enabled && !hasEdgeMiddleware(process.cwd())) {
        // Respect an application-provided cacheHandler rather than silently overwriting it — the two
        // are mutually exclusive (a custom handler owns the incremental cache, so the adapter's
        // shared store can't also own it). Warn and keep theirs; the V2 `use cache` handler still
        // registers at runtime, but cross-replica ISR/PPR-shell sharing needs the adapter's handler.
        const existingHandler =
          (modified as { cacheHandler?: unknown }).cacheHandler ??
          (nextConfig as { cacheHandler?: unknown }).cacheHandler;
        if (existingHandler) {
          console.warn(
            "[adapter-k8s] cache.enabled but next.config already sets `cacheHandler` — keeping " +
              "yours and skipping the adapter's shared incremental cache. Remove your cacheHandler " +
              "for cross-replica ISR / PPR-shell revalidation, or set cache.enabled=false to silence.",
          );
        } else {
          // N50 (review #29): `if (existsSync(src))` silently skipped registration when the
          // bundle was missing, which dropped cross-replica ISR/PPR-shell revalidation with
          // no log line while build-metadata still advertised the cache. adapterBundlePath
          // throws with the path and the fix.
          const src = adapterBundlePath("cache-handler.cjs");
          const destDir = path.join(process.cwd(), ".k8s-adapter");
          await mkdir(destDir, { recursive: true });
          const dest = path.join(destDir, "cache-handler.cjs");
          await copyFile(src, dest);
          modified.cacheHandler = dest;
          // The handler's bundled Redis client uses only `node:net`/`node:tls` (loaded lazily),
          // which Next externalizes automatically — so there's no third-party package to mark
          // external or stage into the pool container.
        }
      }

      return modified as typeof nextConfig;
    },

    async onBuildComplete(ctx: BuildCompleteContext) {
      const { routing, outputs, projectDir, config: nextConfig, buildId, nextVersion } = ctx;
      const repoRoot = (ctx as { repoRoot?: string }).repoRoot ?? projectDir;
      // N50 (review #33): `.next` was hardcoded at every staging site, and each site was
      // guarded by `existsSync`, so a custom `distDir` staged NOTHING (no Turbopack chunks,
      // no `.next/node_modules` externals) and the pool image could not load a single
      // handler — silently, with a green build. Everything below uses ctx.distDir.
      // `distDirRel` is the project-relative form: it is the path INSIDE the image, because
      // handler filePaths are staged as `path.relative(projectDir, …)`.
      const distDir = (ctx as { distDir?: string }).distDir ?? path.join(projectDir, ".next");
      const distDirRel = path.relative(projectDir, distDir);
      // S20 (SECURITY). Every staging destination below is built as
      // `<stageDir>/${distDirRel}`, and `path.relative` happily returns `../…` for a
      // next.config `distDir` outside the project (e.g. "../build"). The shared-image `cp`
      // and the routing-service copies do NOT go through assertStagedWithin, so such a
      // destination resolves OUTSIDE the Docker build context: the copy succeeds, the image
      // silently ships without the build output, and — worse — the external-resolution path
      // does a recursive `rm(dest)` before copying, so the recursive delete lands outside the
      // tree too. Reject at the source, where the message can name the config that caused it.
      if (distDirRel.startsWith("..") || path.isAbsolute(distDirRel)) {
        throw new Error(
          `[adapter-k8s] next.config \`distDir\` must resolve INSIDE the project directory. ` +
            `Got ${JSON.stringify(distDir)}, which is ${JSON.stringify(distDirRel)} relative to ` +
            `${projectDir}. Staging paths are built from that relative form, so an external ` +
            `distDir would place (and recursively delete) files outside the Docker build ` +
            `context and ship an image with no build output.`,
        );
      }

      // The finalized build id (Next's default or a custom `generateBuildId()` — commonly
      // a git ref in CI) flows into helm `--set` values, K8s resource names/labels, image
      // tags, and chart YAML. Validate it here, at the source, so an unsafe id fails the
      // build with a clear message instead of injecting into any of those sinks.
      assertSafeBuildId(buildId);
      // …and the tighter Docker-tag charset (see assertDockerTagSafeBuildId): BUILD_ID_RE
      // accepts a leading "." or "-", which `docker build -t` rejects after a full build.
      assertDockerTagSafeBuildId(buildId);

      // Staging bookkeeping is module-level (exported for tests) — reset both at the START
      // of the build so a previous run in the same process cannot leak state or failures.
      stagedPaths.clear();
      stagingFailures.length = 0;

      // Config and release name are needed by the collision guard below (and the
      // rest of the build); resolve them before any artifact is touched.
      const cfg = await ensureConfig(projectDir);
      const releaseName = deriveReleaseName(projectDir);

      // Blue/green requires the new and current builds to have DISTINCT sanitized K8s
      // names: resource names, pod labels, and the active-Service selector all derive
      // from `${releaseName}-${poolName}-${buildId}` truncated to 63 chars (59 for the
      // -hpa/-hcp variants). Compare the COMPOSED truncated names — comparing
      // sanitizeK8sName(buildId) alone misses the case where a long release+pool
      // prefix truncates the build id away entirely, making EVERY consecutive deploy
      // collide. The deploy CLI performs the same composed-name check against cluster
      // state; catching it at build time fails before any artifact is emitted.
      // Best-effort read: no state file (first deploy) means no comparison. Only the
      // read/parse sits inside the try — the comparison and its throw are OUTSIDE, so
      // the catch can never swallow the guard's own error (the old shape re-threw by
      // matching a message prefix; a reworded message would have no-op'd the guard).
      let previousBuildId: string | null = null;
      try {
        const statePath = path.join(projectDir, ".k8s-adapter", "state.json");
        if (existsSync(statePath)) {
          const state = readJsonFile(statePath, "deploy state (state.json)");
          if (typeof state.buildId === "string") previousBuildId = state.buildId;
        }
      } catch {
        // Unreadable/corrupt state.json: ignore — the deploy-side check is authoritative.
      }
      if (previousBuildId !== null) {
        const collision = findBuildIdNameCollision(
          releaseName,
          Object.keys(cfg.pools),
          buildId,
          previousBuildId,
        );
        if (collision !== null) {
          throw new Error(
            `[adapter-k8s] build id sanitizes to the same K8s name as the previous build: ` +
              `"${buildId}" and "${previousBuildId}" both produce the ${collision.kind} name ` +
              `"${collision.name}" after sanitization and 63-char truncation (release ` +
              `"${releaseName}") — blue/green resource names, pod labels, and the ` +
              `active-Service selector would collide. Choose a distinct generateBuildId, ` +
              `or shorten the release/pool names so more of the build id survives.`,
          );
        }
      }

      // N62 (review #25, routing-tier handoff). Cross-pool collision WITHIN this build —
      // independent of any previous build, so it must run even on a FIRST deploy (state.json
      // is absent in CI: init gitignores .k8s-adapter/, so the guard below never ran there).
      // A pool named `<otherPool>-<buildId>` makes the other pool's VERSIONED name equal this
      // pool's STABLE name; helm emits both documents silently and last-writer-wins, so the
      // HTTPRoute backendRef can resolve to the wrong pool's pods and the cutover patch flips
      // the wrong object's selector.
      const selfCollision = findEmittedNameCollision(releaseName, Object.keys(cfg.pools), [
        buildId,
      ]);
      if (selfCollision !== null) {
        throw new Error(
          `[adapter-k8s] pool names collide within build "${buildId}": the ` +
            `${selfCollision.kind} "${selfCollision.name}" would be emitted TWICE for ` +
            `release "${releaseName}". A pool named "<otherPool>-${buildId}" produces the ` +
            `same K8s name as pool "<otherPool>"'s versioned object — as does a ` +
            `release+pool prefix long enough to truncate the build id away entirely. Rename ` +
            `or shorten the pools.`,
        );
      }

      // Regenerate the Helm chart from a clean slate. Chart files are named per
      // pool/build; without wiping, a removed pool's Deployment/Service or a
      // stale template from a prior build survives and gets re-applied by the
      // next `helm upgrade`. Only the generated chart dir is cleared — staged
      // build contexts and injected previous-build templates live elsewhere and
      // are managed by their own steps.
      const chartDir = path.join(projectDir, OUTPUT_DIR, "chart");
      if (existsSync(chartDir)) await rm(chartDir, { recursive: true, force: true });

      // In a monorepo the tracing root (repoRoot) sits above the app dir (projectDir).
      // Traced assets under projectDir are re-based correctly (see assetDestPath), and
      // deps hoisted to repoRoot/node_modules resolve via the upward node_modules walk.
      // Assets that live in a *sibling* workspace package (outside projectDir, e.g.
      // repoRoot/packages/*) are staged at their repoRoot-relative path and may not be
      // reachable by Node's resolution from the app entrypoint — warn so it's not silent.
      if (repoRoot !== projectDir) {
        console.warn(
          `[adapter-k8s] Monorepo detected (repoRoot ${repoRoot} != projectDir ${projectDir}). ` +
            `Traced dependencies in sibling workspace packages may not resolve at runtime; ` +
            `ensure such deps are hoisted or bundled into the app's node_modules.`,
        );
      }

      // Dump raw build context for debugging
      const debugDir = path.join(projectDir, OUTPUT_DIR, "debug");
      await mkdir(debugDir, { recursive: true });
      await writeFile(
        path.join(debugDir, "build-context.json"),
        JSON.stringify(
          {
            buildId,
            nextVersion,
            basePath: nextConfig.basePath,
            i18n: nextConfig.i18n,
            routing,
            outputKeys: Object.keys(outputs),
            outputs: Object.fromEntries(
              Object.entries(outputs).map(([k, v]) => {
                if (Array.isArray(v)) {
                  return [
                    k,
                    v.map((item: any) => ({
                      ...item,
                      // Truncate large fields
                      assets: item.assets
                        ? `[${Object.keys(item.assets).length} assets]`
                        : undefined,
                    })),
                  ];
                }
                if (v && typeof v === "object" && "filePath" in v) {
                  return [
                    k,
                    {
                      ...v,
                      assets: v.assets ? `[${Object.keys(v.assets).length} assets]` : undefined,
                    },
                  ];
                }
                return [k, v];
              }),
            ),
          },
          null,
          2,
        ),
      );

      // 1. Classify outputs into pools
      const pools = classifyIntoPools(outputs, cfg);

      // 2. Build routing manifest
      const routingManifest = buildRoutingManifest({
        routing,
        outputs,
        pools,
        buildId,
        basePath: nextConfig.basePath ?? "",
        i18n: nextConfig.i18n ?? null,
        trailingSlash: nextConfig.trailingSlash ?? false,
        nextVersion,
        projectDir,
        distDir,
      });

      // 3. Build static asset manifest
      const staticManifest = buildStaticManifest(outputs, projectDir, nextConfig.basePath ?? "");

      // The platform probe paths must belong to the PLATFORM. The pool server deliberately
      // declines to shadow an app that owns `/healthz` or `/readyz` (server.ts
      // appOwnsProbePath) so such a route is not silently swallowed — but the consequence at
      // runtime is worse than the shadowing it avoids: the kubelet, the Gateway
      // HealthCheckPolicy and the blue/green cutover gate all read those paths as the pod's
      // verdict. A static 200 at `/readyz` promotes a pod whose instrumentation register()
      // threw (exactly the failure /readyz was introduced to catch, invariant 3), and an
      // authenticated or failing app route at the same path keeps a HEALTHY pod permanently
      // unready so the deploy can never cut over. Neither is something an app author would
      // connect to a route they wrote. So refuse it HERE, at build time, with a message that
      // says what to do — the same "loud build failure over silent surprise" posture as the
      // emitted-name collision guard above and assertCacheKeyClassification.
      assertProbePathsUnowned({
        pathnames: routingManifest.pathnames ?? [],
        staticPathnames: staticManifest.map((a) => a.pathname),
        publicPathnames: collectPublicPathnames(projectDir),
        basePath: nextConfig.basePath ?? "",
      });

      // 4. Generate Helm chart
      // releaseName was derived up top (deriveReleaseName — infrastructure.json with a
      // capped basename fallback); infrastructure.json also carries namespace/registry/
      // project values consumed below.
      const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
      // N50 (review, Medium): readJsonFile names the file and the remedy — this was a bare
      // JSON.parse whose SyntaxError reached the operator with only a character offset.
      const infra = (
        existsSync(infraPath) ? readJsonFile(infraPath, "infrastructure.json") : {}
      ) as {
        releaseName?: string;
        namespace?: string;
        containerRegistry?: string;
        projectId?: string;
        region?: string;
      };

      // Phase 2 artifacts (Route Extension) — computed before Helm chart so extensionChain is available
      const celExpression = generateCelExpression({
        outputs,
        dynamicRoutes: routing.dynamicRoutes,
        // request.path at the LB includes the basePath — the CEL must too.
        basePath: nextConfig.basePath ?? "",
        // N40: Next never enumerates `public/` as an adapter output, so the CEL's per-file
        // exclusion loop saw NOTHING to exclude — MEASURED on fixtures/main (whose matcher
        // explicitly carves out cdn-probe.txt and header-priority.txt), the emitted
        // expression was `!(request.path.startsWith('/_next/static/'))`, zero per-file
        // exclusions. `collectPublicPathnames` is the same enumeration the static-asset
        // manifest and the pool's pathname set already use, and it is already imported here.
        publicPathnames: collectPublicPathnames(projectDir),
      });

      const failureModeAllow = determineFailureMode(outputs, cfg.routingService?.failureMode);

      const gkeProvider = cfg.provider.gke;

      // infrastructure.json is operator/CI-managed state, but a tampered or hand-edited
      // value here flows into helm --set, resource names, and chart YAML — validate at
      // the point of consumption and fail the build rather than emit an unsafe chart.
      const namespace = infra.namespace ?? K8S_NAMESPACE;
      try {
        assertSafeNamespace(namespace);
      } catch (err) {
        throw new Error(
          `[adapter-k8s] Unsafe namespace in .k8s-adapter/infrastructure.json: ${(err as Error).message}`,
        );
      }
      // The namespace feeds ONLY the ext_proc extension-chain authority
      // (`<release>-routing-service.<namespace>.svc.cluster.local`, extension-chain.ts)
      // — every kubectl/helm call in the CLI pins the literal K8S_NAMESPACE, and init
      // binds Workload Identity to default/<release>-deploy-sa. A non-default value
      // here would land workloads in "default" while the GXLB callout targets the
      // other namespace: every edge callout fails, and diagnostics chase the "wrong"
      // resources. Fail fast at build time instead of emitting a skewed chain.
      if (namespace !== K8S_NAMESPACE) {
        throw new Error(
          `[adapter-k8s] Unsupported namespace "${namespace}" in ` +
            `.k8s-adapter/infrastructure.json: this adapter version deploys only to the ` +
            `"${K8S_NAMESPACE}" namespace (init binds Workload Identity to ` +
            `${K8S_NAMESPACE}/<release>-deploy-sa and every kubectl/helm call pins it). ` +
            `Remove "namespace" from infrastructure.json.`,
        );
      }

      const configuredRegistry = infra.containerRegistry ?? process.env.IMAGE_REGISTRY;
      if (configuredRegistry !== undefined) {
        try {
          assertSafeImageRegistry(configuredRegistry);
        } catch (err) {
          throw new Error(
            `[adapter-k8s] Unsafe image registry from ` +
              `${infra.containerRegistry ? "infrastructure.json containerRegistry" : "the IMAGE_REGISTRY env var"}: ` +
              `${(err as Error).message}`,
          );
        }
      }
      const imageRegistry = configuredRegistry ?? "REGISTRY";

      // projectId/region flow into the extension-chain JSON, which the route-ext
      // ConfigMap template re-interpolates into quoted YAML scalars (service,
      // authority) — validate at the source so a tampered infrastructure.json
      // fails the build instead of injecting into the chart downstream.
      if (infra.projectId !== undefined) {
        try {
          assertSafeProjectId(infra.projectId);
        } catch (err) {
          throw new Error(
            `[adapter-k8s] Unsafe projectId in .k8s-adapter/infrastructure.json: ${(err as Error).message}`,
          );
        }
      }
      if (infra.region !== undefined) {
        try {
          assertSafeRegion(infra.region);
        } catch (err) {
          throw new Error(
            `[adapter-k8s] Unsafe region in .k8s-adapter/infrastructure.json: ${(err as Error).message}`,
          );
        }
      }

      // The GXLB traffic extension can only be described (and registered) once init has
      // written projectId + region: the chain's `service` field is
      // `projects/<projectId>/global/backendServices/<release>-routing-service`, and the
      // update Job needs the region. N50 (review, Medium): this used to render
      // `projectId: infra.projectId ?? ""` — producing `projects//global/backendServices/…`
      // — while helm.ts silently omitted the registration Job for the same missing values,
      // so the chart installed the ext_proc tier and NOTHING ever attached it to the load
      // balancer (the edge kept the previous build's chain) with a green deploy. Emit the
      // chain only when it can actually be registered, and say so loudly when it cannot.
      const canRegisterExtension = !!(infra.projectId && infra.region);
      const extensionChain = canRegisterExtension
        ? generateExtensionChain({
            celExpression,
            releaseName,
            namespace,
            projectId: infra.projectId!,
            timeout: gkeProvider.serviceExtensions?.routeExtension?.timeout
              ? `${gkeProvider.serviceExtensions.routeExtension.timeout}s`
              : "5s",
            failureModeAllow,
          })
        : undefined;
      if (!canRegisterExtension) {
        console.warn(
          `[adapter-k8s] .k8s-adapter/infrastructure.json has no ${
            infra.projectId ? "region" : infra.region ? "projectId" : "projectId/region"
          } — emitting a chart WITHOUT the ext_proc routing tier and without the GXLB ` +
            `traffic-extension registration. Middleware/rewrites/redirects will run in the ` +
            `pools (the fail-safe path), not at the edge. Run \`npx adapter-k8s init\` to ` +
            `provision infrastructure and regenerate infrastructure.json before deploying.`,
        );
      }

      const helmFiles = generateHelmChart({
        pools,
        buildId,
        nextVersion,
        config: cfg,
        imageRegistry,
        routingManifest,
        releaseName,
        ...(extensionChain ? { extensionChainJson: extensionChain } : {}),
        routingFailOpen: failureModeAllow,
        infrastructure: {
          ...(infra.projectId ? { projectId: infra.projectId } : {}),
          ...(infra.region ? { region: infra.region } : {}),
        },
        // Deterministic per build (see deriveInternalSecret) — a re-emit of the same build
        // must produce the same chart, and must not rotate the secret out from under the
        // pods that are currently serving.
        internalSecret: await deriveInternalSecret(projectDir, releaseName, buildId),
        // N72: no `imageDigests` here, deliberately. `next build` runs BEFORE `docker
        // build`/`docker push`, so no digest exists at this point; passing an empty/invented
        // map would only look like the pinning is in place. Until the deploy step resolves
        // digests after push (see generateHelmChart's `imageDigests` doc), the emitted
        // Deployments reference the mutable build-id tag with `imagePullPolicy: Always`,
        // which is the mitigation for a retag.
      });

      for (const [filePath, content] of Object.entries(helmFiles)) {
        // Secret-bearing templates land on disk mode 0600 — they hold the internal
        // dispatch secret / Valkey AUTH and must not be group/world-readable.
        await writeOutputFile(
          projectDir,
          `chart/${filePath}`,
          content,
          OUTPUT_DIR,
          SECRET_CHART_FILES.has(filePath) ? 0o600 : undefined,
        );
      }

      // 5. Build Stage Area & Dockerfiles
      // Skip staging when running in e2e/emulate mode — the pool server reads
      // directly from the dist dir and staging doubles inode usage needlessly.
      const skipStaging = process.env.ADAPTER_K8S_SKIP_STAGING === "1";

      // applyDefaults (config.ts) guarantees this; the local keeps the branch below and the
      // emitted build-metadata in agreement instead of re-defaulting in two places.
      const containerStrategy = cfg.containerStrategy ?? "traced-assets";

      // N50 (review #33): every staging site is guarded by `existsSync`, which is correct for
      // the individually-optional subtrees (`server/chunks`, `node_modules`) but turned a
      // WRONG dist path into a silent no-op — the image then contained no handlers at all.
      // Assert the dist dir itself once, where the message can name it.
      if (!skipStaging && !existsSync(distDir)) {
        throw new Error(
          `[adapter-k8s] Build output directory not found: ${distDir}. The adapter stages the ` +
            `pool images from it, so an image built now would contain no route handlers. ` +
            `(distDir comes from ctx.distDir — next.config \`distDir\`.)`,
        );
      }

      // Whether Next is actually configured to use the adapter's Valkey INCREMENTAL cache
      // handler for this build. ctx.config is the loaded next.config WITH modifyConfig
      // applied, so this is the authoritative answer — it accounts for the edge-middleware
      // skip, an app-provided cacheHandler, and the case where modifyConfig never ran.
      // Staging follows it exactly: staging a handler Next does not reference is dead weight,
      // NOT staging one it does reference is a module-not-found crash loop on startup.
      const adapterCacheHandlerPath = path.join(projectDir, ".k8s-adapter", "cache-handler.cjs");
      const incrementalCacheHandler =
        (nextConfig as { cacheHandler?: string }).cacheHandler === adapterCacheHandlerPath;
      // N50 (review #34): when the shared incremental handler is skipped while the cache is
      // enabled, say so — this used to be entirely silent, so ISR/PPR-shell revalidation
      // quietly became per-replica. build-metadata records it too (incrementalCacheHandler).
      if (cfg.cache?.enabled && !incrementalCacheHandler) {
        const mwRuntime = outputs.middleware?.runtime;
        console.warn(
          `[adapter-k8s] cache.enabled but the shared INCREMENTAL cache handler is NOT ` +
            `registered for this build` +
            (mwRuntime === "edge"
              ? ` (the app has EDGE middleware: a node:net/node:tls client cannot be bundled ` +
                `into the edge runtime)`
              : "") +
            `. ISR and PPR-shell revalidation will be per-replica, not cross-replica. ` +
            `\`use cache\` entries are unaffected (the V2 handler registers at runtime and ` +
            `still shares the Valkey store). Switch middleware to \`export const runtime = ` +
            `"nodejs"\` (or use proxy.ts) for cross-replica ISR.`,
        );
      }
      // N50 (review #34): the pre-build filename heuristic and the build's own answer must
      // agree, or the config we emitted describes a different app than the one that was
      // built. Report a disagreement rather than letting it be invisible.
      if (
        cfg.cache?.enabled &&
        outputs.middleware &&
        outputs.middleware.runtime !== "edge" &&
        !incrementalCacheHandler &&
        !(nextConfig as { cacheHandler?: string }).cacheHandler
      ) {
        console.warn(
          `[adapter-k8s] middleware built for the "${outputs.middleware.runtime}" runtime, but ` +
            `the incremental cache handler was skipped at config time — the middleware source ` +
            `does not declare \`export const runtime = "nodejs"\` where this adapter can see ` +
            `it. Declare it explicitly (or rename to proxy.ts) to get cross-replica ISR.`,
        );
      }

      // NOTE: `.env` / `.env.production` are deliberately NOT staged into any
      // Docker build context. They can hold secrets (DB URLs, non-NEXT_PUBLIC
      // API keys) and would otherwise be baked into pushed image layers. Env is
      // supplied to running containers via Kubernetes (ConfigMap/Secret +
      // envFrom); the runtime reads it from process.env. Each build context
      // also gets a `.dockerignore` (below) so a stray `COPY . .` can't pick
      // one up. Local emulate is unaffected: it runs the servers with
      // cwd=projectDir, so loadEnvConfig reads the real project `.env` directly.

      // ONE pool-manifest shape for all three branches. N50 (review, Medium): the
      // SKIP_STAGING branch built a different one (`o.id ?? o.pathname`, `runtime ?? "nodejs"`,
      // and no `filter(o => !!o.filePath)`), so `path.relative(projectDir, undefined)` threw a
      // bare TypeError for any pool output without a filePath — a case the other two branches
      // defend against — and local emulation validated a manifest shape production never sees.
      const poolManifestJson = (poolName: string, pool: PoolDefinition): string =>
        JSON.stringify(
          {
            buildId,
            poolName,
            outputs: Object.fromEntries(
              pool.outputs
                .filter((o) => !!o.filePath)
                .map((o) => [
                  o.pathname,
                  {
                    id: o.id,
                    filePath: path.relative(projectDir, o.filePath),
                    pathname: o.pathname,
                    type: o.type,
                    runtime:
                      "runtime" in o && typeof o.runtime === "string" ? o.runtime : undefined,
                  },
                ]),
            ),
          },
          null,
          2,
        );

      // Stage an output's traced assets AND its wasmAssets. N50 (review #31): Next emits
      // WASM for edge functions in a SEPARATE field (`output.wasmAssets`, build-complete.ts)
      // and staging only ever read `assets`/`outputs`. Because ext_proc fails CLOSED whenever
      // the app has middleware, an edge middleware bundle that cannot load its WASM is a 500
      // on every request — so the omission is an outage, not a degradation.
      const stageOutputAssets = async (
        output: { assets?: unknown; outputs?: unknown; wasmAssets?: unknown },
        poolName: string,
        isShared: boolean,
      ) => {
        const groups = [
          output.assets ?? (output as { outputs?: unknown }).outputs,
          output.wasmAssets,
        ];
        for (const group of groups) {
          if (!group || typeof group !== "object") continue;
          for (const [relAsset, absAsset] of Object.entries(group as Record<string, unknown>)) {
            if (typeof absAsset !== "string") continue;
            await stageFile(
              projectDir,
              absAsset,
              assetDestPath(projectDir, relAsset, absAsset),
              poolName,
              isShared,
            );
          }
        }
      };

      // Files EVERY emitted app image needs, whatever the container strategy. N50
      // (review #30): the shared-image branch omitted all of these while writing a
      // static-assets.json into the same context that references every public file by
      // `public/<name>` — so every public asset 404'd from a shared image, and the
      // `@next/routing` / sharp gaps were the same crash-at-runtime shapes the traced-assets
      // branch already guarded against.
      const stageCommonRuntimeFiles = async (poolName: string, isShared: boolean) => {
        // public/ files (favicon, robots, arbitrary static assets). They are NOT in Next's
        // staticFiles output, so nothing else stages them, and the pool's public-file fast
        // path 404s without them. Enumerate with the same helper the router uses.
        for (const publicPathname of collectPublicPathnames(projectDir)) {
          const rel = `public${publicPathname}`; // publicPathname starts with "/"
          await stageFile(projectDir, path.join(projectDir, rel), rel, poolName, isShared);
        }

        // @next/routing (the pool server's local route resolution — the fail-safe path).
        // Resolve adapter-first (it is the adapter's own dependency); a silent skip ships an
        // image that crashes with "Cannot find module '@next/routing'".
        const nextRoutingDir = resolveDepDir("@next/routing", projectDir);
        if (!nextRoutingDir || !existsSync(nextRoutingDir)) {
          throw new Error(
            `[adapter-k8s] Could not resolve @next/routing from ${projectDir}. It is required ` +
              `at runtime by the pool server. Ensure @next/routing is installed and resolvable ` +
              `from your app (it is a dependency of @next-community/adapter-k8s).`,
          );
        }
        await stageFile(
          projectDir,
          nextRoutingDir,
          "node_modules/@next/routing",
          poolName,
          isShared,
        );

        // The registered incremental cache handler. Next resolves `next.config.cacheHandler`
        // at runtime relative to the app root, so the image must carry it at the same
        // project-relative path or the pool crashes with module-not-found on startup.
        if (incrementalCacheHandler) {
          if (!existsSync(adapterCacheHandlerPath)) {
            throw new Error(
              `[adapter-k8s] next.config.cacheHandler points at ${adapterCacheHandlerPath}, ` +
                `which does not exist — the emitted image would crash on startup with ` +
                `"Cannot find module". Re-run the build (the adapter writes it in ` +
                `modifyConfig) and do not delete .k8s-adapter/ mid-build.`,
            );
          }
          await stageFile(
            projectDir,
            adapterCacheHandlerPath,
            ".k8s-adapter/cache-handler.cjs",
            poolName,
            isShared,
          );
        }

        // sharp's native linux-x64 packages (see stageSharpRuntimePackages) — pool-server.cjs
        // inlines sharp's JS but requires the platform binding at RUNTIME.
        return stageSharpRuntimePackages(projectDir, poolName, resolveSharpDepDir, isShared);
      };

      if (skipStaging) {
        // Only write pool manifests — skip Docker context staging (saves thousands of inodes)
        for (const [poolName, pool] of pools) {
          await writeOutputFile(
            projectDir,
            `pool-manifest-${poolName}.json`,
            poolManifestJson(poolName, pool),
          );
        }
      } else if (containerStrategy === "shared-image") {
        const sharedStageDir = "shared-context";
        const absSharedStageDir = path.join(OUTPUT_DIR, sharedStageDir);

        // Wipe the context first — see the N50 note in the traced-assets branch: `cp` MERGES,
        // so without this a file deleted from the source keeps shipping inside the image.
        await rm(path.join(projectDir, absSharedStageDir), { recursive: true, force: true });

        // Stage everything for shared image. `<distDir>/cache` is deliberately excluded: it
        // is the build's own file-system cache (fetch cache, ISR entries) and baking it into
        // the image bloats layers and ships build-time cache state into every replica.
        const distCacheDir = path.join(distDir, "cache");
        await cp(distDir, path.join(projectDir, absSharedStageDir, distDirRel), {
          recursive: true,
          dereference: true,
          filter: (src) => src !== distCacheDir && !src.startsWith(distCacheDir + path.sep),
        });
        await cp(
          path.join(projectDir, "node_modules"),
          path.join(projectDir, absSharedStageDir, "node_modules"),
          { recursive: true, dereference: true },
        );
        // The app's package.json, with `type` forced to commonjs. The image executes only
        // BUILD OUTPUT (`<dist>/server/**/*.js`, which Turbopack emits as CJS) plus
        // pool-server.cjs — under a `"type": "module"` package.json Node would load those
        // `.js` files as ESM and the pool could not require a single handler. The
        // traced-assets context has always pinned `{"type":"commonjs"}` for exactly this
        // reason (N50, review #30: shared-image copied the app's file verbatim instead).
        const appPkgPath = path.join(projectDir, "package.json");
        const appPkg = existsSync(appPkgPath) ? readJsonFile(appPkgPath, "package.json") : {};
        await writeOutputFile(
          projectDir,
          "package.json",
          JSON.stringify({ ...appPkg, type: "commonjs" }, null, 2),
          absSharedStageDir,
        );

        const sharpStaging = await stageCommonRuntimeFiles("shared", true);

        // Keep .env secrets out of the shared image (built from this context).
        await writeOutputFile(
          projectDir,
          ".dockerignore",
          generateDockerignore(),
          absSharedStageDir,
        );

        await writeOutputFile(
          projectDir,
          "pool-server.cjs",
          readAdapterBundle("pool-server.cjs"),
          absSharedStageDir,
        );

        await writeOutputFile(
          projectDir,
          "config/routing-manifest.json",
          JSON.stringify(routingManifest, null, 2),
          absSharedStageDir,
        );
        await writeOutputFile(
          projectDir,
          "config/static-assets.json",
          JSON.stringify(staticManifest, null, 2),
          absSharedStageDir,
        );

        for (const [poolName, pool] of pools) {
          await writeOutputFile(
            projectDir,
            `config/pool-manifest-${poolName}.json`,
            poolManifestJson(poolName, pool),
            absSharedStageDir,
          );
        }

        await writeOutputFile(
          projectDir,
          "Dockerfile",
          // Base image version comes from DEFAULT_EMITTED_NODE_VERSION (dockerfiles.ts)
          // — Node >= 24 is required for the manifest's inline (?i:) regexes (N24).
          generateDockerfile({
            containerStrategy: "shared-image",
            buildId,
            ...(!sharpStaging.staged && sharpStaging.sharpVersion
              ? { installSharpVersion: sharpStaging.sharpVersion }
              : {}),
          }),
          absSharedStageDir,
        );
      } else {
        for (const [poolName, pool] of pools) {
          const poolDir = path.join(OUTPUT_DIR, "pools", poolName);
          const poolStageDir = path.join(poolDir, "context");

          // N50 (review #32, reproduced): WIPE the build context before staging. Invariant 5
          // wiped only `output/chart`; the pool `context/` dirs persisted across builds and
          // `stageFile` copies with `cp(..., { recursive: true })`, which MERGES. Measured
          // consequences: a chunk deleted from the source stayed in the context (and in the
          // image); the same for `<dist>/server/app/**` of routes that no longer exist,
          // `node_modules/next` across a Next upgrade, and `public/` — a deleted public file
          // kept shipping and stayed reachable by the pool's filesystem path. The
          // routing-service branch below already did this, with a comment about exactly this
          // hazard; the pool branch now mirrors the chart-dir invariant.
          await rm(path.join(projectDir, poolStageDir), { recursive: true, force: true });

          // Copy required files into context
          for (const output of pool.outputs) {
            if (!output.filePath) continue;
            const relPath = path.relative(projectDir, output.filePath);
            await stageFile(projectDir, output.filePath, relPath, poolName);
            await stageOutputAssets(
              output as Parameters<typeof stageOutputAssets>[0],
              poolName,
              false,
            );
          }

          // Stage static/public/prerender files into EVERY pool image, not just
          // the default one. static-assets.json is written to every pool's config
          // (so every dispatcher knows these paths), and the gateway routes a
          // shared URL prefix to whichever pool owns a route under it — which may
          // be a non-default pool. If the files lived only in the default pool,
          // a public asset under such a prefix would 404 on the pool that
          // actually receives it. (Phase 4 CDN/GCS offload will move these off
          // the pods entirely and make this staging unnecessary.)
          for (const asset of staticManifest) {
            const absPath = path.resolve(projectDir, asset.filePath);
            await stageFile(projectDir, absPath, asset.filePath, poolName);
          }

          if (outputs.middleware?.filePath) {
            const relPath = path.relative(projectDir, outputs.middleware.filePath);
            await stageFile(projectDir, outputs.middleware.filePath, relPath, poolName);
            // Middleware's traced assets AND its wasmAssets (see stageOutputAssets).
            await stageOutputAssets(outputs.middleware, poolName, false);
          }

          // Stage <distDir>/server/chunks/ — required by Turbopack runtime for
          // middleware and handler chunk loading
          const chunksDir = path.join(distDir, "server", "chunks");
          if (existsSync(chunksDir)) {
            await stageFile(
              projectDir,
              chunksDir,
              path.join(distDirRel, "server", "chunks"),
              poolName,
            );
          }

          // Stage <distDir>/node_modules/ — Turbopack's resolved external modules
          // (hashed names like @opentelemetry/api-6ec0324a2d0bd38c)
          // These are symlinks pointing outside the dist dir — Docker COPY can't follow them.
          // Resolve each symlink and copy the real content.
          const nextNodeModules = path.join(distDir, "node_modules");
          if (existsSync(nextNodeModules)) {
            const dest = path.join(projectDir, poolStageDir, distDirRel, "node_modules");
            await resolveAndCopyExternals(nextNodeModules, dest);
          }

          // Stage next/setup-node-env (required for AsyncLocalStorage initialization).
          // N50 (review, Low): `<projectDir>/node_modules/next` under an existsSync guard
          // silently staged NOTHING in a hoisted workspace (npm/yarn put `next` at the
          // workspace root), which is a "Cannot find module 'next/...'" crash in the pool.
          // Resolve it the same way @next/routing is resolved, and fail loudly.
          const nextPkgDir = resolveDepDir("next", projectDir);
          if (!nextPkgDir || !existsSync(nextPkgDir)) {
            throw new Error(
              `[adapter-k8s] Could not resolve the "next" package from ${projectDir}. The pool ` +
                `server requires next/dist/server/setup-node-env at runtime (AsyncLocalStorage ` +
                `initialization). Ensure "next" is installed and resolvable from your app.`,
            );
          }
          await stageFile(projectDir, nextPkgDir, "node_modules/next", poolName);

          const sharpStaging = await stageCommonRuntimeFiles(poolName, false);

          // Keep .env secrets out of the pool image. The Dockerfile's
          // `COPY context/ .` runs from this pool dir (the docker build
          // context), so the .dockerignore lives here alongside the Dockerfile.
          await writeOutputFile(projectDir, ".dockerignore", generateDockerignore(), poolDir);

          // Shared context files
          await writeOutputFile(
            projectDir,
            "package.json",
            JSON.stringify({ type: "commonjs" }),
            poolStageDir,
          );
          await writeOutputFile(
            projectDir,
            "pool-server.cjs",
            readAdapterBundle("pool-server.cjs"),
            poolStageDir,
          );

          await writeOutputFile(
            projectDir,
            `config/pool-manifest-${poolName}.json`,
            poolManifestJson(poolName, pool),
            poolStageDir,
          );
          await writeOutputFile(
            projectDir,
            "config/routing-manifest.json",
            JSON.stringify(routingManifest, null, 2),
            poolStageDir,
          );
          await writeOutputFile(
            projectDir,
            "config/static-assets.json",
            JSON.stringify(staticManifest, null, 2),
            poolStageDir,
          );

          await writeOutputFile(
            projectDir,
            `Dockerfile`,
            generatePoolDockerfile({
              poolName,
              buildId,
              // Build host lacked linux-x64 sharp packages — install in-image instead,
              // pinned to the app's sharp so the native ABI matches the inlined JS.
              ...(!sharpStaging.staged && sharpStaging.sharpVersion
                ? { installSharpVersion: sharpStaging.sharpVersion }
                : {}),
            }),
            poolDir,
          );
        }
      }

      // 6. Write final artifacts to output root for CLI visibility
      await writeOutputFile(
        projectDir,
        "routing-manifest.json",
        JSON.stringify(routingManifest, null, 2),
      );
      await writeOutputFile(
        projectDir,
        "static-assets.json",
        JSON.stringify(staticManifest, null, 2),
      );
      // Deploy/rollback read this to decide whether to invalidate the outgoing build's CDN tag.
      // Emitted here (not infra state, which lacks cdn config); a missing/false flag = no-op.
      await writeOutputFile(
        projectDir,
        "cdn-invalidation.json",
        JSON.stringify({ invalidateOnDeploy: gkeProvider.cdn?.invalidateOnDeploy ?? true }),
      );

      // Phase 2 artifacts — write to output (computation moved above Helm chart generation).
      // Only when the chain is registerable: an extension-chains.json rendering
      // `projects//global/backendServices/…` is not a diagnostic, it is a trap.
      if (extensionChain) {
        await writeOutputFile(projectDir, "extension-chains.json", extensionChain);
      }
      await writeOutputFile(projectDir, "cel-expression.txt", celExpression);

      // Routing service Dockerfile + context (skip when staging is disabled)
      if (!skipStaging) {
        const routingServiceDir = path.join(OUTPUT_DIR, "routing-service");

        await writeOutputFile(
          projectDir,
          "Dockerfile",
          generateRoutingServiceDockerfile({ buildId }),
          routingServiceDir,
        );

        const routingServiceContextDir = path.join(routingServiceDir, "context");

        // Same wipe-before-stage rule as the pool contexts (N50, review #32): this dir
        // persists across builds and `cp` merges. The per-item `rm`s below predate this and
        // are now redundant, but harmless — and they document which items are re-staged.
        await rm(path.join(projectDir, routingServiceContextDir), {
          recursive: true,
          force: true,
        });

        // Copy routing-service runtime (from adapter package dist/). esbuild bundles
        // connectrpc/protobuf-es and the generated ext_proc Envoy types into this CJS
        // bundle, so there's no separate .proto file to stage. N50 (review #29): a missing
        // bundle used to be skipped silently, shipping an image whose CMD runs a file that
        // is not there (CrashLoopBackOff, no build-time signal).
        await writeOutputFile(
          projectDir,
          "routing-service.cjs",
          readAdapterBundle("routing-service.cjs"),
          routingServiceContextDir,
        );

        // Routing manifest for the routing service
        await writeOutputFile(
          projectDir,
          "config/routing-manifest.json",
          JSON.stringify(routingManifest, null, 2),
          routingServiceContextDir,
        );

        // Stage runtime dependencies for routing service (externals not bundled by esbuild)
        // connectrpc/protobuf-es and the generated Envoy protos are bundled into
        // routing-service.mjs; only @next/routing is external.
        const routingServiceDeps = ["@next/routing"];
        for (const dep of routingServiceDeps) {
          // Resolve adapter-first (@next/routing is the adapter's own dependency). A silent
          // skip here ships a routing-service image that crashloops with "Cannot find module
          // '@next/routing'" — exactly how it failed undetected. Fail the build loudly.
          const depDir = resolveDepDir(dep, projectDir);
          if (!depDir || !existsSync(depDir)) {
            throw new Error(
              `[adapter-k8s] Could not resolve ${dep} for the routing service from ${projectDir}. ` +
                `It is required at runtime by the routing service (ext_proc). Ensure it is installed ` +
                `and resolvable from your app.`,
            );
          }
          const dest = path.join(
            projectDir,
            routingServiceContextDir,
            "node_modules",
            ...dep.split("/"),
          );
          // Refresh every build (the context dir persists) so a dependency upgrade actually ships
          // rather than being shadowed by a stale copy from an earlier build.
          await rm(dest, { recursive: true, force: true });
          await mkdir(path.dirname(dest), { recursive: true });
          await cp(depDir, dest, { recursive: true, dereference: true });
        }

        // Keep .env secrets out of the routing-service image. `docker build`
        // uses the routing-service dir as its context, so the .dockerignore lives
        // there alongside the Dockerfile.
        await writeOutputFile(
          projectDir,
          ".dockerignore",
          generateDockerignore(),
          routingServiceDir,
        );

        // Stage middleware module + its chunk dependencies. These MUST be re-copied every build:
        // the routing-service context dir persists across builds, and a prior `if (!existsSync)`
        // guard here froze the ext_proc tier at the first build's middleware (its `middleware.js`
        // pins a specific chunk hash, so a stale copy silently runs old middleware code forever).
        if (outputs.middleware?.filePath && existsSync(outputs.middleware.filePath)) {
          const mwRelPath = path.relative(projectDir, outputs.middleware.filePath);
          const mwDest = path.join(projectDir, routingServiceContextDir, mwRelPath);
          await mkdir(path.dirname(mwDest), { recursive: true });
          await copyFile(outputs.middleware.filePath, mwDest);
          // Stage middleware's traced assets AND its wasmAssets (files and directories).
          // N50 (review #31): wasmAssets were never staged anywhere, and this tier is the one
          // that runs middleware at the edge — with ext_proc failing CLOSED whenever the app
          // has middleware, a bundle that cannot load its WASM is a 500 on every request.
          const mwAssets: Record<string, unknown> = {
            ...(outputs.middleware as { assets?: Record<string, string> }).assets,
            ...(outputs.middleware as { wasmAssets?: Record<string, string> }).wasmAssets,
          };
          for (const [relAsset, absAsset] of Object.entries(mwAssets)) {
            if (typeof absAsset === "string" && existsSync(absAsset)) {
              const relDest = assetDestPath(projectDir, relAsset, absAsset);
              const contextRoot = path.join(projectDir, routingServiceContextDir);
              const dest = path.join(contextRoot, relDest);
              // Same containment rule as stageFile (N50, review #9): this branch does its own
              // copying, so it needs its own assertion — a `../`-keyed asset must never land
              // outside the build context (or overwrite repo files).
              assertStagedWithin(contextRoot, dest, relDest);
              await mkdir(path.dirname(dest), { recursive: true });
              const stat = statSync(absAsset);
              if (stat.isDirectory()) {
                await cp(absAsset, dest, { recursive: true, dereference: true });
              } else {
                await copyFile(absAsset, dest);
              }
            }
          }
          // Stage <distDir>/server/chunks/ for Turbopack runtime chunk loading
          const chunksDir = path.join(distDir, "server", "chunks");
          const chunksDest = path.join(
            projectDir,
            routingServiceContextDir,
            distDirRel,
            "server",
            "chunks",
          );

          // Stage <distDir>/node_modules/ — Turbopack's resolved external modules
          const nextNodeModules = path.join(distDir, "node_modules");
          const nextNodeModulesDest = path.join(
            projectDir,
            routingServiceContextDir,
            distDirRel,
            "node_modules",
          );
          if (existsSync(nextNodeModules)) {
            await resolveAndCopyExternals(nextNodeModules, nextNodeModulesDest);
          }
          if (existsSync(chunksDir)) {
            // Replace the whole chunk set (not merge) so a stale prior build's chunks can't linger
            // and shadow the current middleware's referenced chunk.
            await rm(chunksDest, { recursive: true, force: true });
            await mkdir(path.dirname(chunksDest), { recursive: true });
            await cp(chunksDir, chunksDest, { recursive: true, dereference: true });
          }
        }
      } // end if (!skipStaging)

      await writeOutputFile(
        projectDir,
        "build-metadata.json",
        generateBuildMetadata({
          buildId,
          nextVersion,
          poolNames: [...pools.keys()],
          // N50 (review #20): NOT `new Date()`. A wall-clock stamp made every regeneration of
          // the same build produce a different build-metadata.json, which defeats the only
          // audit for invariant 5 (diff a regenerated artifact against what was applied).
          // routingManifest.builtAt is the build's stable timestamp (SOURCE_DATE_EPOCH, else
          // the <distDir>/BUILD_ID mtime — see manifest.ts stableBuiltAt).
          generatedAt: routingManifest.builtAt,
          containerStrategy,
          hasMiddleware: !!outputs.middleware,
          failureModeAllow,
          cacheEnabled: cfg.cache?.enabled ?? false,
          cacheManaged: !!cfg.cache?.enabled && !cfg.cache.url,
          // Deliberately NOT folded into cacheEnabled: the review suggested reporting
          // cacheEnabled:false when this handler is skipped, but deploy.ts:383/:442 use
          // cacheEnabled/cacheManaged to PROVISION and TEAR DOWN the managed Memorystore, and
          // the V2 `use cache` handler (registered at runtime via the global symbol) does use
          // that instance regardless of this flag. Reporting false would delete a cache that
          // is in use. This field records the actual gap instead, and the build logs it.
          incrementalCacheHandler,
          ...(cfg.cache?.memorystore ? { cacheMemorystore: cfg.cache.memorystore } : {}),
        }),
      );

      // Every staging failure collected during this build (N50, review Medium): fail here
      // with the full list rather than emitting an image that is missing files.
      assertNoStagingFailures();
    },
  };

  // Expose config for ensureConfig to find when it imports an existing adapter instance
  Object.defineProperty(adapter, "config", {
    get: () => config,
    enumerable: false,
  });

  return adapter;
}
