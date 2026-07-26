// src/cli/cdn-invalidate.ts
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { RECORDED_CDN_TAG_PATTERN } from "../cdn-tags.js";

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
 * Resolve EVERY Cloud CDN url-map that serves the release, deterministically from the
 * release's reserved static IP (never name-matching — the same anti-collision rule as
 * route-ext-update-job): IP → forwarding rules → target proxies → url-maps. Every gcloud
 * call's exitCode is checked, and an unrecognized proxy target type is skipped rather
 * than guessed. Returns the distinct url-map names (empty when nothing could be
 * resolved; the caller warns and skips — non-fatal).
 *
 * N27: this used to `return` on the FIRST url-map it found. `forwarding-rules list`
 * ordering is unspecified, and the chart provisions BOTH an http:80 and an https:443
 * forwarding rule on the same IP with different route sets (gateway.ts, plus a separate
 * `<release>-http-redirect` HTTPRoute). So a cutover could purge the redirect-only map,
 * report success, and leave every stale entry on the real map serving — the same class as
 * the M13 stale-apex incident this function exists for. Invalidate all of them.
 */
export async function resolveCdnUrlMaps(
  projectId: string,
  releaseName: string,
  run: Runner,
): Promise<string[]> {
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
  if (!ip) return [];

  const frRes = await run("gcloud", [
    "compute",
    "forwarding-rules",
    "list",
    `--project=${projectId}`,
    `--filter=IPAddress=${ip}`,
    "--format=value(target)",
  ]);
  if (frRes.exitCode !== 0) return [];

  const targets = frRes.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const urlMaps: string[] = [];
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
    if (!urlMap) continue; // this proxy is unreadable — keep going, the others still matter
    const name = basename(urlMap);
    if (name && !urlMaps.includes(name)) urlMaps.push(name);
  }
  return urlMaps;
}

/**
 * Invalidate the Cloud CDN entries for `buildId` (the OUTGOING build on a cutover or
 * rollback) so its stale content stops serving. One synchronous call — waits for Google's
 * operation to complete (no `--async`). Best-effort and non-fatal: any failure logs and returns.
 * Skips when there is no outgoing build, when `cdn-invalidation.json` opts out
 * (`invalidateOnDeploy: false`), or when the url-map can't be resolved. A missing OR malformed
 * sidecar defaults to ON — an enabled feature is never silently disabled.
 *
 * M13 (2026-07-22 stale-apex incident): the outgoing build's cache entries were stamped by
 * ITS pool-server, built under whatever adapter version existed at ITS deploy. Re-deriving
 * the tag from the CURRENT code silently misses entries whenever the derivation changed, and
 * can never touch entries the older pool-server did not tag at all (the incident: prerendered
 * `/` cached untagged with `s-maxage=31536000` sailed through a correctly-computed tag
 * invalidation). So `recordedTag` — read from deploy state, written when the outgoing build
 * went out — is the ONLY tag ever used. With no recorded tag (build predates recording, so
 * its entries have unknown or no tags), fall back to a full `--path=/*` purge: coarser, but
 * the only selector that reaches those entries. The wildcard also drops the incoming build's
 * seconds-old entries — harmless, they refill on the next request.
 */
export async function invalidateCdnBuildTag(opts: {
  projectId: string;
  releaseName: string;
  outputDir: string;
  buildId: string | undefined;
  /** Cache-Tag recorded in deploy state at the outgoing build's deploy (M13). */
  recordedTag?: string | undefined;
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

  const urlMaps = await resolveCdnUrlMaps(opts.projectId, opts.releaseName, opts.run);
  if (urlMaps.length === 0) {
    opts.log(
      "  ! CDN invalidation skipped: could not resolve ANY url-map behind the release IP " +
        "(non-fatal) — the outgoing build's cached entries keep serving until their TTL",
    );
    return;
  }

  // Validate at the point of consumption: the recorded tag comes from state.json / the
  // cluster ConfigMap and reaches gcloud argv (and Cloud CDN's comma-delimited --tags).
  // A malformed value is treated as "not recorded" — full purge — never spliced in.
  if (opts.recordedTag !== undefined && !RECORDED_CDN_TAG_PATTERN.test(opts.recordedTag)) {
    opts.log(`  ! Recorded CDN tag for outgoing build is malformed — falling back to a full purge`);
  }
  const recordedTag =
    opts.recordedTag !== undefined && RECORDED_CDN_TAG_PATTERN.test(opts.recordedTag)
      ? opts.recordedTag
      : undefined;
  // N27: every url-map behind the release IP, not just the first one found.
  let failures = 0;
  for (const urlMap of urlMaps) {
    opts.log(
      recordedTag
        ? `  → Invalidating CDN cache for outgoing build (tag ${recordedTag}) on ${urlMap}...`
        : `  → Invalidating CDN cache for outgoing build (no recorded tag — full purge ` +
            `--path=/*) on ${urlMap}...`,
    );
    const r = await opts.run(
      "gcloud",
      [
        "compute",
        "url-maps",
        "invalidate-cdn-cache",
        urlMap,
        // M13: recorded tag when we have one (precise, cheap); otherwise the outgoing
        // build's entries carry unknown/no tags and only a path wildcard reaches them.
        recordedTag ? `--tags=${recordedTag}` : "--path=/*",
        "--global",
        `--project=${opts.projectId}`,
      ], // no --async: wait for the operation to complete
      { timeoutMs: CDN_INVALIDATE_TIMEOUT_MS },
    );
    if (r.exitCode !== 0) {
      failures++;
      opts.log(
        `  ! CDN invalidation failed for ${urlMap} (non-fatal; TTL self-heals): ` +
          `${r.stderr.trim().slice(0, 200)}`,
      );
    }
  }
  if (failures === 0) {
    opts.log(
      `  → CDN cache invalidation complete ✓ (${urlMaps.length} url-map${urlMaps.length === 1 ? "" : "s"})`,
    );
  }
}
