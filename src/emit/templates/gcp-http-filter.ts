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

// The routing extension's dispatch verdict must partition the cache as well: the pool
// dispatches directly on these request headers, so a middleware rewrite / A/B pool choice
// can produce a different cacheable body for the same public URL. The extension mutates
// them before the CDN cache lookup, so they are visible to the cache key.
// x-matched-pathname always duplicates x-output-id; the shared secret must never be keyed.
export const DEFAULT_CDN_CACHE_KEY_HEADERS: string[] = [
  ...NEXTJS_VARY_HEADERS,
  ...INTERNAL_DISPATCH_HEADERS.filter((h) => h !== "x-matched-pathname"),
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
  for (const header of cacheKeyHeaders) {
    if (!HEADER_NAME_RE.test(header)) {
      throw new Error(
        `Invalid CDN cache-key header "${header}": must match ${HEADER_NAME_RE}.`,
      );
    }
    if (header.toLowerCase() === INTERNAL_SECRET_HEADER) {
      throw new Error(
        `"${INTERNAL_SECRET_HEADER}" must never be part of the CDN cache key.`,
      );
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
