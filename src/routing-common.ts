import { detectLocale, detectDomainLocale, normalizeLocalePath } from "@next/routing";

// Shared routing helpers used by BOTH resolvers — the ext_proc edge
// (routing-service/handler.ts, "Phase 2") and the pool's local resolver
// (pool-server/resolve.ts, "Phase 1"). Keeping these in one place prevents the two
// paths from drifting; a divergence here means production (ext_proc) and emulate
// (Phase 1) route the same request differently.

// Internal request headers set by the routing extension / cross-pool proxy. Clients
// must never be able to speak this dispatch protocol, so the pool strips them unless
// they arrive with a valid internal secret (see pool-server/server.ts), and the routing
// service overwrites/clears them on every response it returns.
export const INTERNAL_DISPATCH_HEADERS = [
  "x-output-id",
  "x-matched-pathname",
  "x-route-matches",
  "x-upstream-pool",
  "x-nextjs-ppr",
  "x-resolved-headers",
] as const;

// Header carrying the shared secret that authenticates the dispatch headers above.
// Present only on responses from the trusted routing extension / cross-pool proxy.
export const INTERNAL_SECRET_HEADER = "x-internal-secret";

// A compiled middleware matcher entry from middleware-manifest.json.
export interface MiddlewareMatcher {
  regexp: string;
  has?: RouteHasCondition[];
  missing?: RouteHasCondition[];
  originalSource?: string;
}
export interface RouteHasCondition {
  type: "header" | "cookie" | "query" | "host";
  key?: string;
  value?: string;
}

function conditionPresent(cond: RouteHasCondition, headers: Headers, url: URL): boolean {
  let actual: string | null | undefined;
  switch (cond.type) {
    case "header":
      actual = cond.key ? headers.get(cond.key) : undefined;
      break;
    case "query":
      actual = cond.key ? url.searchParams.get(cond.key) : undefined;
      break;
    case "cookie": {
      const cookie = headers.get("cookie");
      if (cookie && cond.key) {
        for (const part of cookie.split(";")) {
          const [k, ...v] = part.trim().split("=");
          if (k === cond.key) {
            actual = v.join("=");
            break;
          }
        }
      }
      break;
    }
    case "host":
      actual = url.hostname;
      break;
  }
  if (actual === null || actual === undefined) return false;
  if (cond.value === undefined) return true; // presence-only
  try {
    return new RegExp(`^${cond.value}$`).test(actual);
  } catch {
    return cond.value === actual;
  }
}

// Decide whether middleware should run for a request, honoring its `matcher`
// config (source regexp + has/missing conditions). Without this, middleware
// runs on every path — breaking matcher-gated middleware (has/missing) and any
// source-restricted matcher. Empty/absent matchers → run always (a middleware
// with no config.matcher compiles to a catch-all, but be safe).
export function matchesMiddleware(
  matchers: MiddlewareMatcher[] | undefined,
  url: URL,
  headers: Headers,
): boolean {
  if (!matchers || matchers.length === 0) return true;
  for (const m of matchers) {
    let re: RegExp;
    try {
      re = new RegExp(m.regexp);
    } catch {
      continue;
    }
    if (!re.test(url.pathname)) continue;
    const hasOk = (m.has ?? []).every((c) => conditionPresent(c, headers, url));
    const missingOk = (m.missing ?? []).every((c) => !conditionPresent(c, headers, url));
    if (hasOk && missingOk) return true;
  }
  return false;
}

// Strip basePath only at a segment boundary — "/docsy" must NOT be treated as
// under basePath "/docs" (upstream requires `p === base || p.startsWith(base + "/")`).
export function stripBasePath(pathname: string, basePath: string): string {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(basePath + "/")) return pathname.slice(basePath.length);
  return pathname;
}

// Match a concrete (percent-decoded) request pathname against dynamic-route
// output templates ("/blog/[slug]", "/docs/[...parts]", "/x/[[...opt]]").
// Handlers for prerendered dynamic routes are keyed by the TEMPLATE while
// routing resolves the concrete path, so dispatch needs this to find them.
export function templateOutputCandidates(pathname: string, outputIds: string[]): string[] {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // keep encoded form
  }
  const paths = decoded === pathname ? [pathname] : [pathname, decoded];
  const matches: string[] = [];
  for (const id of outputIds) {
    if (!id.includes("[")) continue;
    const segs = id.split("/").slice(1);
    let pattern = "";
    let valid = true;
    for (const seg of segs) {
      if (/^\[\[\.\.\..+\]\]$/.test(seg)) {
        pattern += "(?:/.+)?"; // optional catch-all
      } else if (/^\[\.\.\..+\]$/.test(seg)) {
        pattern += "/.+"; // catch-all
      } else if (/^\[.+\]$/.test(seg)) {
        pattern += "/[^/]+"; // dynamic segment
      } else if (seg.includes("[")) {
        valid = false; // partial-segment templates unsupported
        break;
      } else {
        pattern += "/" + seg.replace(/[.*+?^${}()|\\]/g, "\\$&");
      }
    }
    if (!valid) continue;
    const re = new RegExp(`^${pattern}/?$`);
    if (paths.some((c) => re.test(c))) matches.push(id);
  }
  // Prefer more specific templates: catch-alls are less specific than single
  // dynamic segments, which are less specific than literals.
  const weight = (id: string) =>
    (id.match(/\[/g)?.length ?? 0) + (id.includes("...") ? 10 : 0);
  return matches.sort((a, b) => weight(a) - weight(b));
}

export function trailingSlashVariants(pathname: string): string[] {
  if (pathname === "/") return ["/"];
  const withSlash = pathname.endsWith("/") ? pathname : pathname + "/";
  const withoutSlash = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return [pathname, withoutSlash, withSlash];
}

// Resolve a pathname to its owning pool. A route may be keyed in poolAssignments with or
// without a trailing slash, and i18n routes arrive locale-prefixed (/en/about) while the
// assignment is keyed unprefixed (/about). Falls back to the "default" pool, then the first
// assignment. NOTE: the fallback is a best-effort guess — if it guesses wrong the pool's
// cross-pool proxy (dispatch.ts) still recovers, at the cost of an extra hop.
export function lookupPool(
  poolAssignments: Record<string, string>,
  resolvedPathname: string | undefined,
  matchedPathname: string,
  i18nLocales?: string[],
): string | undefined {
  const candidates: string[] = [];
  if (resolvedPathname) candidates.push(...trailingSlashVariants(resolvedPathname));
  candidates.push(...trailingSlashVariants(matchedPathname));

  // Also try stripping i18n locale prefix (e.g., /en/about → /about)
  if (i18nLocales?.length) {
    const extra: string[] = [];
    for (const c of candidates) {
      for (const locale of i18nLocales) {
        const prefix = `/${locale}`;
        if (c.startsWith(prefix + "/") || c === prefix) {
          extra.push(...trailingSlashVariants(c.slice(prefix.length) || "/"));
        }
      }
    }
    candidates.push(...extra);
  }

  for (const p of candidates) {
    if (poolAssignments[p]) return poolAssignments[p];
  }
  return poolAssignments["default"] ?? Object.values(poolAssignments)[0];
}

// @next/routing locale-prefixes unprefixed request paths internally before
// running route rules, but never surfaces the prefixed URL: when no route
// matches, the caller falls back to the ORIGINAL pathname, losing the locale
// (outputs are keyed locale-prefixed, e.g. "/en/about"). It also malformes the
// root as "/en/" (trailing slash), spuriously firing the trailing-slash 308
// rule and dropping the query. Prevent both at the source: pre-prefix every
// unprefixed page path with the locale resolveRoutes would pick, using
// @next/routing's own exported detection helpers so the logic cannot drift
// (same skip conditions: /_next/*, /api/*, already-prefixed). Only the
// no-redirect case is pre-prefixed — when detection would send the visitor to
// a non-default locale, resolveRoutes must still produce that redirect itself.
export function prefixRequestLocale(
  url: URL,
  headers: Headers,
  i18n:
    | {
        locales: string[];
        defaultLocale: string;
        localeDetection?: false;
        domains?: Array<{ defaultLocale: string; domain: string; http?: true; locales?: string[] }>;
      }
    | null
    | undefined,
  basePath: string,
  trailingSlash?: boolean,
): string | null {
  if (!i18n?.locales?.length) return null;
  const path = stripBasePath(url.pathname, basePath);
  if (path.startsWith("/_next/") || path.startsWith("/api/")) return null;
  if (normalizeLocalePath(path, i18n.locales).detectedLocale) return null; // already prefixed

  const domainLocale = detectDomainLocale(i18n.domains as never, url.hostname);
  const defaultLocale = domainLocale?.defaultLocale || i18n.defaultLocale;
  let locale = defaultLocale;
  if (i18n.localeDetection !== false) {
    locale = detectLocale({
      pathname: path,
      hostname: url.hostname,
      cookieHeader: headers.get("cookie") ?? undefined,
      acceptLanguageHeader: headers.get("accept-language") ?? undefined,
      i18n: i18n as never,
    }).locale;
    if (locale !== defaultLocale) return null; // resolveRoutes will redirect — leave it
  }
  if (path === "/") {
    // With trailingSlash: true the add-slash rule matches "/en" and would 308
    // the root — prefix in the canonical slashed form so no rule fires.
    url.pathname = trailingSlash ? `${basePath}/${locale}/` : `${basePath}/${locale}`;
  } else {
    url.pathname = `${basePath}/${locale}${path}`;
  }
  return locale;
}

// Rule redirects can also capture the internal locale prefix into their
// destinations. Neither artifact exists upstream (next start applies
// rules to the unprefixed path). Normalize redirect results:
//  - target locale-stripped == original path and status 308: the redirect is
//    purely the internal trailing-slash artifact → caller must RE-RESOLVE with
//    the locale-prefixed path (returned as retryUrl), preserving the query.
//  - target locale-stripped == original path and status 307: this is the i18n
//    locale-detection redirect; keep it but fix the "/fr/" → "/fr" slash.
//  - otherwise: the rule leaked the internal locale prefix → strip it.
// Middleware-issued redirects arrive via resolvedHeaders (not resolution.redirect)
// and are never passed through this function.
export function normalizeI18nRedirect(
  redirect: { url: URL; status: number },
  requestUrl: URL,
  i18n: { locales: string[]; defaultLocale: string } | null | undefined,
  basePath: string,
  addedLocale?: string | null,
): { kind: "keep" } | { kind: "rewrite"; url: URL } | { kind: "retry"; retryUrl: URL } {
  if (!i18n?.locales?.length) return { kind: "keep" };

  const stripBase = (p: string) => stripBasePath(p, basePath);
  const localeOf = (p: string): { locale?: string | undefined; rest: string } => {
    const norm = normalizeLocalePath(p, i18n.locales);
    return { locale: norm.detectedLocale, rest: norm.pathname };
  };

  const origPath = stripBase(requestUrl.pathname);
  if (localeOf(origPath).locale) return { kind: "keep" }; // request was already locale-scoped

  const target = redirect.url;
  const targetPath = stripBase(target.pathname);
  const { locale, rest } = localeOf(targetPath);
  if (!locale) return { kind: "keep" };

  const crossOrigin = target.origin !== requestUrl.origin;
  if (crossOrigin) {
    // Domain locale redirects keep their locale; only fix the root slash artifact.
    if (targetPath === `/${locale}/`) {
      const url = new URL(target.toString());
      url.pathname = url.pathname.slice(0, -1);
      return { kind: "rewrite", url };
    }
    return { kind: "keep" };
  }

  if (rest === origPath) {
    if (redirect.status === 307) {
      // Locale-detection redirect: keep, fixing "/fr/" → "/fr" for the root.
      if (targetPath === `/${locale}/`) {
        const url = new URL(target.toString());
        url.pathname = url.pathname.slice(0, -1);
        return { kind: "rewrite", url };
      }
      return { kind: "keep" };
    }
    // Trailing-slash artifact of internal prefixing: re-resolve, don't redirect.
    const retryUrl = new URL(requestUrl.toString());
    retryUrl.pathname = `${basePath}/${locale}${origPath === "/" ? "" : origPath}`;
    return { kind: "retry", retryUrl };
  }

  // Rule redirects whose target carries exactly the locale WE auto-added
  // captured the internal prefix — upstream ran the rule on the unprefixed
  // path, so its Location has no locale. Explicit locale destinations
  // (`locale: false` rules pointing at a DIFFERENT locale) are untouched, and
  // stripping the auto-added (detected/default) locale is render-equivalent
  // even when the destination named it explicitly.
  if (addedLocale && locale.toLowerCase() === addedLocale.toLowerCase()) {
    const url = new URL(target.toString());
    url.pathname = `${basePath}${rest === "/" ? "" : rest}` || "/";
    return { kind: "rewrite", url };
  }
  return { kind: "keep" };
}

// Trailing-slash normalization rules redirect via a `Location: /$1` header,
// which (a) cannot express "keep the original query" — upstream preserves it —
// and (b) captures the internal locale prefix when the rule ran on the
// locale-prefixed internal URL (upstream applies these rules to the unprefixed
// path, so its Location never contains an auto-added locale). Both corrections
// apply ONLY when the redirect is a pure slash-flip of the request path, so
// middleware redirects to genuinely different paths are untouched.
export function normalizeLocationRedirect(
  target: URL,
  requestUrl: URL,
  i18n: { locales: string[] } | null | undefined,
  basePath: string,
  addedLocale?: string | null,
): void {
  if (target.origin !== requestUrl.origin) return;

  const stripBase = (p: string) => stripBasePath(p, basePath);
  // Pure slash-flip: identical paths modulo exactly one trailing slash.
  const isSlashFlip = (a: string, b: string) => a === `${b}/` || `${a}/` === b;

  const origPath = stripBase(requestUrl.pathname);
  let targetPath = stripBase(target.pathname);

  // Strip an internally-added locale from slash-flip redirects. Only when the
  // original request carried no locale prefix (so explicit locale destinations
  // survive) and the stripped target is a pure slash-flip of the original.
  if (i18n?.locales?.length) {
    const localeOf = (p: string) => {
      const seg = p.split("/", 2)[1]?.toLowerCase();
      const match = seg && i18n.locales.find((l) => l.toLowerCase() === seg);
      return match ? { locale: match, rest: p.slice(match.length + 1) || "/" } : { rest: p };
    };
    if (!localeOf(origPath).locale) {
      const t = localeOf(targetPath);
      // Strip when the target is a pure slash-flip of the original (trailing
      // slash rules), or when the leaked locale is exactly the one we
      // auto-added (config redirects capture it; upstream ran the rule on the
      // unprefixed path). Different-locale targets are deliberate and kept.
      if (
        t.locale &&
        (isSlashFlip(t.rest, origPath) ||
          (addedLocale && t.locale.toLowerCase() === addedLocale.toLowerCase()))
      ) {
        targetPath = t.rest;
        target.pathname = `${basePath}${targetPath === "/" ? "" : targetPath}` || "/";
      }
    }
  }

  // Preserve the query across pure slash-flip redirects.
  if (!target.search && requestUrl.search && isSlashFlip(target.pathname, requestUrl.pathname)) {
    target.search = requestUrl.search;
  }
}

// --- Shared resolution orchestration -----------------------------------------
// The pre-resolution request normalization and post-resolution redirect
// normalization run in BOTH resolvers (pool-server/resolve.ts Phase 1 and
// routing-service/handler.ts Phase 2). They live here as one sequence — not
// just shared primitives — because the two call sites have already proven they
// drift when mirrored by hand. The middleware invocation blocks intentionally
// remain per-resolver (the edge sandbox path exists only in the pool).

export interface PreparedRequest {
  kind: "ok";
  /** Locale-prefixed URL to hand to resolveRoutes. */
  url: URL;
  /** Untouched request URL — redirect normalization compares against this. */
  originalUrl: URL;
  addedLocale: string | null;
}

export type PrepareResult =
  | PreparedRequest
  | { kind: "error"; status: number }
  | { kind: "redirect"; url: URL; status: number };

export function prepareRequest(
  requestUrl: URL,
  headers: Headers,
  manifest: {
    i18n?: unknown;
    basePath: string;
    trailingSlash?: boolean | undefined;
  },
): PrepareResult {
  // Malformed percent-encoding in the path → 400, matching upstream.
  try {
    decodeURIComponent(requestUrl.pathname);
  } catch {
    return { kind: "error", status: 400 };
  }

  // Repeated slashes: 308 to the collapsed path, matching upstream.
  const collapsed = collapseSlashesRedirect(requestUrl);
  if (collapsed) return { kind: "redirect", url: collapsed, status: 308 };

  const originalUrl = new URL(requestUrl.toString());
  const url = new URL(requestUrl.toString());
  const addedLocale = prefixRequestLocale(
    url,
    headers,
    manifest.i18n as never,
    manifest.basePath,
    manifest.trailingSlash,
  );
  return { kind: "ok", url, originalUrl, addedLocale };
}

// Post-resolution redirect handling, shared verbatim by both resolvers:
//  - resolution.redirect (rule/detection redirects) → i18n-normalized, may retry
//  - Location + redirect-status in resolvedHeaders (middleware / header-only
//    rules) → resolved against the ORIGINAL request URL per HTTP semantics,
//    slash-flip query preservation and locale-leak stripping applied.
// Both shapes carry resolvedHeaders so middleware Set-Cookie and custom
// redirect headers survive on every phase.
export function normalizeResolvedRedirect(
  resolution: {
    redirect?: { url: URL; status: number } | undefined;
    resolvedHeaders?: Headers | undefined;
    status?: number | undefined;
  },
  prep: PreparedRequest,
  manifest: { i18n?: unknown; basePath: string },
):
  | { kind: "redirect"; url: URL; status: number; resolvedHeaders: Headers | undefined }
  | { kind: "retry"; retryUrl: URL }
  | null {
  const i18n = manifest.i18n as { locales: string[]; defaultLocale: string } | null | undefined;

  if (resolution.redirect) {
    const norm = normalizeI18nRedirect(
      resolution.redirect,
      prep.originalUrl,
      i18n,
      manifest.basePath,
      prep.addedLocale,
    );
    if (norm.kind === "retry") return { kind: "retry", retryUrl: norm.retryUrl };
    return {
      kind: "redirect",
      url: norm.kind === "rewrite" ? norm.url : resolution.redirect.url,
      status: resolution.redirect.status,
      resolvedHeaders: resolution.resolvedHeaders ?? undefined,
    };
  }

  const location = resolution.resolvedHeaders?.get("location");
  if (location && [301, 302, 303, 307, 308].includes(resolution.status ?? 0)) {
    const target = new URL(location, prep.originalUrl);
    normalizeLocationRedirect(target, prep.originalUrl, i18n, manifest.basePath, prep.addedLocale);
    return {
      kind: "redirect",
      url: target,
      status: resolution.status!,
      resolvedHeaders: resolution.resolvedHeaders ?? undefined,
    };
  }

  return null;
}

// Manifest-derived config assembled in one place — the web adapter and the edge
// sandbox both need it, across four call sites that previously hand-built it.
export function manifestNextConfig(manifest: {
  basePath: string;
  i18n?: unknown;
  trailingSlash?: boolean | undefined;
}): { basePath?: string | undefined; i18n?: unknown; trailingSlash?: boolean | undefined } {
  return {
    basePath: manifest.basePath || undefined,
    i18n: (manifest.i18n as never) ?? undefined,
    trailingSlash: manifest.trailingSlash || undefined,
  };
}

export function getRscConfig(manifest: {
  routeGraph?: unknown;
}): RscConfig | undefined {
  return (manifest.routeGraph as { rsc?: RscConfig } | undefined)?.rsc;
}

// Upstream Next normalizes repeated slashes in the request path with a 308 to
// the collapsed path (query preserved). Returns the redirect target, or null
// when the path is already normal.
export function collapseSlashesRedirect(url: URL): URL | null {
  if (!/\/{2,}/.test(url.pathname)) return null;
  const out = new URL(url.toString());
  out.pathname = url.pathname.replace(/\/{2,}/g, "/");
  return out;
}

// A dynamic-route match (e.g. "/[id]") must not shadow a concrete prerendered
// output for the request path — upstream serves the prerender. Outputs are
// keyed by DECODED pathname ("/sticks & stones") while requests arrive encoded
// ("/sticks%20%26%20stones"), so try the decoded form too. Returns the concrete
// output pathname, or undefined to keep the resolver's own result.
export function preferConcreteOutput(
  requestPathname: string,
  resolvedPathname: string,
  poolAssignments: Record<string, string>,
): string | undefined {
  if (poolAssignments[resolvedPathname]) {
    // The resolver's result is itself a known output; only override when it is
    // a dynamic template and a concrete output exists for the request path.
    if (!resolvedPathname.includes("[")) return undefined;
  }
  const candidates = [requestPathname];
  try {
    const decoded = decodeURIComponent(requestPathname);
    if (decoded !== requestPathname) candidates.push(decoded);
  } catch {
    // malformed escape — leave as-is
  }
  for (const c of candidates) {
    if (c !== resolvedPathname && poolAssignments[c]) return c;
  }
  return undefined;
}

// Map a matched pathname to the key outputs are actually registered under.
// Two shape mismatches arise with trailingSlash: true — requests carry a
// trailing slash while outputs are keyed without one, and the root page is
// keyed "/index" rather than "/". Only remaps when the remapped key actually
// exists, so locale-prefixed pathnames and exact matches pass through.
export function normalizeMatchedPathname(
  pathname: string,
  poolAssignments: Record<string, string>,
): string {
  if (poolAssignments[pathname]) return pathname;
  for (const v of trailingSlashVariants(pathname)) {
    if (poolAssignments[v]) return v;
  }
  if (pathname === "/" && poolAssignments["/index"]) return "/index";
  return pathname;
}

export interface RscConfig {
  header: string;
  suffix: string;
  prefetchSegmentHeader?: string;
  prefetchSegmentDirSuffix?: string;
  prefetchSegmentSuffix?: string;
}

// Map a resolved pathname to its RSC output variant when the request is an RSC request.
// resolveRoutes returns the base pathname (e.g. /page); the handler must be dispatched to the
// .rsc output (e.g. /page.rsc) so it returns a flight payload instead of HTML, and to the
// segment-prefetch output for a partial-tree prefetch. Returns the input unchanged when the
// request isn't RSC or no matching output exists. Pool assignment is unaffected — the .rsc
// output lives in the same pool as its page — so callers look up the pool on the BASE
// pathname and only use this result for the output id (x-output-id).
// Inverse of resolveRscOutput: candidates for the parent page of an RSC output id
// (e.g. "/page.rsc" → "/page", "/index.segments/_tree.segment.rsc" → "/", "/index.rsc" → "/").
// Prerendered RSC variants have no handler of their own — the parent page handler
// serves the flight payload (the rsc request headers drive content negotiation).
export function rscParentCandidates(pathname: string, rsc: RscConfig | undefined): string[] {
  if (!rsc) return [];
  const fromBase = (base: string): string[] => (base === "/index" ? ["/", base] : [base]);
  if (rsc.prefetchSegmentDirSuffix) {
    const i = pathname.indexOf(`${rsc.prefetchSegmentDirSuffix}/`);
    if (i !== -1) return fromBase(pathname.slice(0, i) || "/");
  }
  if (rsc.suffix && pathname.endsWith(rsc.suffix)) {
    return fromBase(pathname.slice(0, -rsc.suffix.length) || "/");
  }
  return [];
}

export function resolveRscOutput(
  matchedPathname: string,
  headers: Headers,
  rscConfig: RscConfig | undefined,
  poolAssignments: Record<string, string>,
): string {
  if (!rscConfig || headers.get(rscConfig.header) !== "1") return matchedPathname;

  const basePath = matchedPathname === "/" ? "/index" : matchedPathname;

  // Segment prefetch (a specific RSC segment) takes precedence over the whole-page .rsc.
  if (rscConfig.prefetchSegmentHeader) {
    const segmentPrefetch = headers.get(rscConfig.prefetchSegmentHeader);
    if (segmentPrefetch && segmentPrefetch.length > 0) {
      const normalized = segmentPrefetch.replace(/^\/+/, "");
      const candidate = `${basePath}${rscConfig.prefetchSegmentDirSuffix ?? ""}/${normalized}${rscConfig.prefetchSegmentSuffix ?? ""}`;
      if (poolAssignments[candidate]) return candidate;
    }
  }

  const rscCandidate = `${basePath}${rscConfig.suffix}`;
  if (poolAssignments[rscCandidate]) return rscCandidate;

  return matchedPathname;
}
