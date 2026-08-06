// src/emit/templates/gcp-http-filter.ts
import { INTERNAL_DISPATCH_HEADERS, INTERNAL_SECRET_HEADER } from "../../routing-common.js";
import { sanitizeK8sName, assertSafeReleaseName } from "./utils.js";

// Next.js App Router response `Vary` headers. Cloud CDN refuses to cache a response whose
// Vary names a header outside its small supported set — unless that header is part of the
// cache key, which both unblocks caching and partitions RSC vs HTML entries correctly.
// NOTE: this must be the COMPLETE set of headers Next.js names in its App Router
// `Vary` response. Any Vary value NOT in the cache key makes Cloud CDN treat the
// response as uncacheable — so a single missing entry (e.g. Next-Router-Segment-Prefetch,
// which Next.js 16.2 emits) silently prevents ALL App Router HTML/RSC edge caching.
export const NEXTJS_VARY_HEADERS = [
  "RSC",
  "Next-Router-State-Tree",
  "Next-Router-Prefetch",
  "Next-Router-Segment-Prefetch",
  "Next-Url",
] as const;

// S10 (SECURITY/CORRECTNESS). The dispatch headers are NOT in the cache key, and must not be.
//
// This block used to add them, justified by "the extension mutates them before the CDN cache
// lookup, so they are visible to the cache key". That is false on this load balancer, and this
// repo had already proven it: docs/superpowers/plans/gcp-edge-compute-cdn-findings.md (Status:
// Definitive, triangulated against the live GCP API and the verbatim processing-order text)
// records that the cache lookup happens AFTER edge extensions while traffic extensions run
// LAST — measured on the metal as "cached key + gate → 200 | ext_proc is post-cache → cache
// hits bypass it". pool-server/index.ts states the same ordering correctly.
//
// Two consequences followed, and both are fixed by removing them:
//   • SECURITY. At lookup time these headers hold whatever the CLIENT sent — handler.ts's
//     scrub happens afterwards and cannot help. So any client could mint unbounded distinct
//     CDN entries for any cacheable URL by varying x-output-id, evicting hot entries and
//     forcing an origin fetch per request (cache-busting / origin amplification).
//   • CORRECTNESS. Partitioning the cache by the extension's verdict is unachievable by
//     construction on a post-cache extension, so the entries bought nothing. Responses whose
//     body genuinely depends on a middleware verdict are forced no-cache anyway
//     (cache-policy.ts) — that is why middleware routes reach the extension at all.
//
// If a verdict ever does need to partition the cache, it has to ride in something the
// PRE-cache request already distinguishes — the path or query — not a header the extension
// stamps afterwards.
//
// The classification below is kept (and still enforced) because it is what makes that
// reasoning explicit for the next header someone adds: every dispatch header must be declared
// NEVER_KEYED, and `assertCacheKeyClassification` fails the render on an unclassified one.
export const NEVER_KEYED_DISPATCH_HEADERS: readonly string[] = [
  // Duplicates x-output-id — keying it only splits identical entries.
  "x-matched-pathname",
  // REQUEST-SCOPED: the middleware's whole final request-header set, cookie included.
  "x-mw-request-headers",
  // S10: every remaining dispatch header. The extension that sets them runs AFTER the cache
  // lookup, so at lookup time their values are the client's — keying on them hands an
  // anonymous client control of the cache key while partitioning nothing.
  "x-output-id",
  "x-route-matches",
  "x-upstream-pool",
  "x-nextjs-ppr",
  "x-resolved-headers",
  "x-mw-evaluated",
  "x-invoke-path",
  "x-invoke-query",
  // REQUEST-SCOPED and stamped only after cache lookup; keying it would guarantee misses.
  "x-adapter-k8s-execution-deadline",
];

/**
 * S10: deliberately EMPTY. A dispatch header could only belong in the cache key if its value
 * were established before the cache lookup — and on this load balancer the extension that
 * establishes them runs after it. Kept as the explicit other half of the classification so
 * `assertCacheKeyClassification` still forces a decision on any header added later; putting
 * one back here needs a documented pre-cache mechanism, not just a rationale.
 */
export const KEYED_DISPATCH_HEADERS: readonly string[] = [];

/**
 * Every dispatch header must be classified exactly once. Throws with the offending name so a
 * new header in routing-common.ts is a loud build failure rather than a silent cache-key
 * change (either a shattered hit rate, or two distinct responses sharing one entry).
 */
export function assertCacheKeyClassification(): void {
  const keyed = new Set(KEYED_DISPATCH_HEADERS);
  const never = new Set(NEVER_KEYED_DISPATCH_HEADERS);
  for (const header of INTERNAL_DISPATCH_HEADERS) {
    const inKeyed = keyed.has(header);
    const inNever = never.has(header);
    if (inKeyed === inNever) {
      throw new Error(
        `Internal dispatch header "${header}" is ${inKeyed ? "in BOTH" : "in NEITHER"} ` +
          `KEYED_DISPATCH_HEADERS and NEVER_KEYED_DISPATCH_HEADERS (gcp-http-filter.ts). ` +
          `Classify it: put it in KEYED_DISPATCH_HEADERS only if the POOL dispatches on it ` +
          `and two values yield two different cacheable bodies; put it in ` +
          `NEVER_KEYED_DISPATCH_HEADERS if it duplicates another key, or if it can carry ` +
          `REQUEST-SCOPED data (cookies, credentials, per-user headers) — such a header ` +
          `makes the Cloud CDN cache key per-user.`,
      );
    }
  }
  for (const header of [...keyed, ...never]) {
    if (!(INTERNAL_DISPATCH_HEADERS as readonly string[]).includes(header)) {
      throw new Error(
        `"${header}" is classified in gcp-http-filter.ts but is not an internal dispatch ` +
          `header any more (routing-common.ts INTERNAL_DISPATCH_HEADERS). Remove it.`,
      );
    }
  }
}

export const DEFAULT_CDN_CACHE_KEY_HEADERS: string[] = [
  ...NEXTJS_VARY_HEADERS,
  // Emitted in INTERNAL_DISPATCH_HEADERS order so the rendered list stays stable when the
  // classification arrays are reordered.
  ...INTERNAL_DISPATCH_HEADERS.filter((h) =>
    (KEYED_DISPATCH_HEADERS as readonly string[]).includes(h),
  ),
];

// Header names are spliced into YAML; reject anything outside plain token chars.
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;

export function renderCdnFilter({
  releaseName,
  cacheMode = "USE_ORIGIN_HEADERS",
  cacheKeyHeaders = DEFAULT_CDN_CACHE_KEY_HEADERS,
}: {
  releaseName: string;
  cacheMode?: "USE_ORIGIN_HEADERS" | undefined;
  cacheKeyHeaders?: string[] | undefined;
}): string {
  assertSafeReleaseName(releaseName);
  // S12 (SECURITY). `cacheMode` is only a TypeScript literal union — nothing checks it at
  // runtime, and it arrives from the user's next.config via provider.gke.cdn. It is emitted as
  // a BARE YAML scalar below, so a value containing a newline plus `---` appends an entire
  // extra Kubernetes document that `helm upgrade` then applies with the deployer's permissions.
  // Only one mode is supported, so compare against it rather than charset-checking.
  if (cacheMode !== "USE_ORIGIN_HEADERS") {
    throw new Error(
      `Invalid cdn.cacheMode ${JSON.stringify(cacheMode)}: the only supported value is ` +
        `"USE_ORIGIN_HEADERS" (it is interpolated into a bare YAML scalar in the emitted ` +
        `GCPHTTPFilter).`,
    );
  }
  // N40b. Fail the build if a dispatch header was added without deciding whether it belongs
  // in the cache key. Checked here (not only in a test) because this is the render that
  // produces the GCPHTTPFilter, and the default list is derived from that classification.
  assertCacheKeyClassification();
  for (const header of cacheKeyHeaders) {
    if (!HEADER_NAME_RE.test(header)) {
      throw new Error(`Invalid CDN cache-key header "${header}": must match ${HEADER_NAME_RE}.`);
    }
    if (header.toLowerCase() === INTERNAL_SECRET_HEADER) {
      throw new Error(`"${INTERNAL_SECRET_HEADER}" must never be part of the CDN cache key.`);
    }
  }

  const name = sanitizeK8sName(`${releaseName}-cdn`);
  const headerLines = cacheKeyHeaders.map((h) => `        - ${h}`).join("\n");

  return `apiVersion: networking.gke.io/v1
kind: GCPHTTPFilter
metadata:
  name: ${name}
spec:
  cachePolicy:
    cacheMode: ${cacheMode}
    negativeCaching: false
    requestCoalescing: true
    cacheKeyPolicy:
      includeHost: true
      includeProtocol: true
      includeQueryString: true
      includedHeaderNames:
${headerLines}
`;
}
