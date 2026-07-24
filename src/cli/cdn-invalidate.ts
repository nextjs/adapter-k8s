// src/cli/cdn-invalidate.ts
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { cdnTagForBuildId } from "../cdn-tags.js";

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

// The synchronous `invalidate-cdn-cache` waits on Google's long-running operation; a
// wedged operation previously hung the whole deploy (no timeout existed anywhere). Cap
// it generously — invalidation normally completes in well under a minute.
const CDN_INVALIDATE_TIMEOUT_MS = 10 * 60 * 1000;

const basename = (s: string): string => s.trim().split("/").pop() ?? "";
const okOut = (r: { exitCode: number; stdout: string }): string =>
  r.exitCode === 0 ? r.stdout.trim() : "";

/**
 * Resolve the Cloud CDN url-map that `invalidate-cdn-cache` targets, deterministically from the
 * release's reserved static IP (never name-matching — the same anti-collision rule as
 * route-ext-update-job): IP → forwarding rule → target proxy → url-map. Every gcloud call's
 * exitCode is checked, and an unrecognized proxy target type is skipped rather than guessed.
 * Returns the url-map name, or null if any step fails (caller warns and skips — non-fatal).
 */
export async function resolveCdnUrlMap(
  projectId: string,
  releaseName: string,
  run: Runner,
): Promise<string | null> {
  const ip = okOut(
    await run("gcloud", [
      "compute",
      "addresses",
      "describe",
      `${releaseName}-ip`,
      "--global",
      `--project=${projectId}`,
      "--format=value(address)",
    ]),
  );
  if (!ip) return null;

  const frRes = await run("gcloud", [
    "compute",
    "forwarding-rules",
    "list",
    `--project=${projectId}`,
    `--filter=IPAddress=${ip}`,
    "--format=value(target)",
  ]);
  if (frRes.exitCode !== 0) return null;

  const targets = frRes.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const target of targets) {
    const kind = target.includes("targetHttpsProxies")
      ? "target-https-proxies"
      : target.includes("targetHttpProxies")
        ? "target-http-proxies"
        : null;
    if (!kind) continue; // unknown target type — do not guess
    const urlMap = okOut(
      await run("gcloud", [
        "compute",
        kind,
        "describe",
        basename(target),
        "--global",
        `--project=${projectId}`,
        "--format=value(urlMap)",
      ]),
    );
    if (urlMap) return basename(urlMap);
  }
  return null;
}

/**
 * Invalidate the Cloud CDN entries tagged for `buildId` (the OUTGOING build on a cutover or
 * rollback) so its stale content stops serving. One synchronous call — waits for Google's
 * operation to complete (no `--async`). Best-effort and non-fatal: any failure logs and returns.
 * Skips when there is no outgoing build, when `cdn-invalidation.json` opts out
 * (`invalidateOnDeploy: false`), or when the url-map can't be resolved. A missing OR malformed
 * sidecar defaults to ON — an enabled feature is never silently disabled.
 */
export async function invalidateCdnBuildTag(opts: {
  projectId: string;
  releaseName: string;
  outputDir: string;
  buildId: string | undefined;
  run: Runner;
  log: (message: string) => void;
}): Promise<void> {
  if (!opts.buildId) return; // no outgoing build (e.g. first deploy)

  const cfgPath = path.join(opts.outputDir, "cdn-invalidation.json");
  if (existsSync(cfgPath)) {
    try {
      if (JSON.parse(readFileSync(cfgPath, "utf-8")).invalidateOnDeploy === false) return;
    } catch {
      // malformed sidecar → default ON (never silently disable an enabled feature)
    }
  }

  const urlMap = await resolveCdnUrlMap(opts.projectId, opts.releaseName, opts.run);
  if (!urlMap) {
    opts.log("  ! CDN invalidation skipped: could not resolve url-map (non-fatal)");
    return;
  }

  const tag = cdnTagForBuildId(opts.buildId);
  opts.log(`  → Invalidating CDN cache for outgoing build (tag ${tag}) on ${urlMap}...`);
  const r = await opts.run(
    "gcloud",
    [
      "compute",
      "url-maps",
      "invalidate-cdn-cache",
      urlMap,
      `--tags=${tag}`,
      "--global",
      `--project=${opts.projectId}`,
    ], // no --async: wait for the operation to complete
    { timeoutMs: CDN_INVALIDATE_TIMEOUT_MS },
  );
  if (r.exitCode !== 0) {
    opts.log(
      `  ! CDN invalidation failed (non-fatal; TTL self-heals): ${r.stderr.trim().slice(0, 200)}`,
    );
  } else {
    opts.log("  → CDN cache invalidation complete ✓");
  }
}
