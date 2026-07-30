import type { AdapterOutputs } from "./types.js";
import type { Route } from "@next/routing";

export interface CelGenerationInput {
  outputs: AdapterOutputs;
  dynamicRoutes: Route[];
  /**
   * next.config basePath ("" when unset). request.path at the load balancer is the
   * RAW :path, which includes the basePath — without prefixing, every comparison
   * below silently never fires for a basePath app (exclusions don't exclude,
   * inclusions don't include). Middleware matcher sourceRegexes already carry the
   * basePath (Next bakes it into the matcher source before compiling), so the
   * middleware-match probe must test the basePath-prefixed pathname too.
   */
  basePath?: string;
}

/**
 * Escape a pathname for safe interpolation into a CEL single-quoted string literal.
 *
 * Every byte outside the RFC 3986 path-character set is percent-encoded (UTF-8,
 * uppercase hex) so the CEL literal matches the raw wire :path — a non-ASCII public
 * file (café.txt → /caf%C3%A9.txt), a space (my file.txt → /my%20file.txt), or a URL
 * delimiter (%, ?, #) always arrives percent-encoded. Previously any such file
 * HARD-FAILED `next build` here, and even before that the emitted exact-match
 * exclusions could never fire for them.
 *
 * Raw control characters are still rejected: they would silently fold inside the
 * YAML scalar the CEL text is later embedded in (route-extension.yaml) and corrupt
 * the extension spec — and no legitimate request-target carries them raw.
 */
// Hoisted: escapeCelString/percentEncodePath run per character of every public
// file pathname — constructing a TextEncoder per character showed up as pure waste.
const TEXT_ENCODER = new TextEncoder();

// Percent-encode every byte outside the RFC 3986 path-character set (UTF-8,
// uppercase hex) — the on-the-wire form of a pathname as the LB sees it in :path.
//
// BYTE-EXACTNESS NOTE: CEL string operations (==, startsWith) are byte-exact —
// there is no case-insensitive or percent-normalizing comparison at the load
// balancer. We emit UPPERCASE hex; a client that sends the same bytes as
// lowercase hex (/caf%c3%a9.txt) will NOT match the emitted literal, which fails
// SAFE: the request simply isn't excluded and flows through ext_proc (one extra
// callout, never a middleware bypass).
function percentEncodePath(value: string): string {
  let out = "";
  for (const ch of value) {
    if (/^[A-Za-z0-9\-._~!$&'()*+,;=:@/]$/.test(ch)) {
      out += ch;
    } else {
      for (const byte of TEXT_ENCODER.encode(ch)) {
        out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

export function escapeCelString(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(
      `Cannot embed ${JSON.stringify(value)} in the CEL match condition: ` +
        `control characters are not supported (they would corrupt the ` +
        `route-extension YAML). Rename the file to remove them.`,
    );
  }
  return percentEncodePath(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Next bakes i18n dynamic routes with a leading locale capture group — either the
// i18n-injected `(?<nextLocale>…)` or a user `[locale]` param (`(?<nxtPlocale>…)`).
// The group contributes no literal path text, so extracting THROUGH it yields "/"
// (a match-all prefix) for routes that actually have a static prefix:
// `^/(?<nxtPlocale>en|fr)/blog/…` gave "/" instead of "/blog/". Skip it — but only
// a locale-named group: a leading NON-locale dynamic segment (`^/(?<slug>[^/]+?)`)
// really does match any first segment, so "/" is its honest prefix.
const LEADING_LOCALE_GROUP_RE = /^(?:\/|\[\/\]\?)?\(\?<[^>]*[Ll]ocale[^>]*>[^()]*\)/;

// Extract the enumerable locale alternatives from a leading locale group
// (`en|fr` → ["en","fr"]), or null when the group is absent or non-enumerable
// (e.g. `(?<nextLocale>[^/]{1,})`). Alternatives must be plain path segments —
// anything else can't be spliced into a startsWith() prefix.
function leadingLocaleAlternatives(sourceRegex: string): string[] | null {
  const withoutAnchor = sourceRegex.replace(/^\^/, "");
  const m = withoutAnchor.match(LEADING_LOCALE_GROUP_RE);
  if (!m) return null;
  const alternatives = m[0]
    .match(/\(\?<[^>]*>([^()]*)\)/)?.[1]
    ?.split("|")
    .map((alt) => alt.replace(/\\(.)/g, "$1")); // unescape e.g. nl\-NL → nl-NL
  if (!alternatives?.length || !alternatives.every((a) => /^[A-Za-z0-9-]+$/.test(a))) {
    return null;
  }
  return alternatives;
}

export function extractStaticPrefix(sourceRegex: string): string | null {
  const withoutAnchor = sourceRegex.replace(/^\^/, "");
  if (LEADING_LOCALE_GROUP_RE.test(withoutAnchor) && !leadingLocaleAlternatives(sourceRegex)) {
    // A leading locale-named group whose alternatives can NOT be enumerated — a user
    // `[locale]` dynamic param like `(?<nxtPlocale>[^/]+?)` (any group name containing
    // "locale", e.g. `[localeId]`, lands here too). Stripping it would yield a prefix
    // like "/blog/" while the requests that actually arrive are locale-prefixed
    // ("/en/blog/x"), so the emitted startsWith inclusion could NEVER fire and the
    // route extension would be silently disabled for the route. Keep the pre-strip
    // behavior: "/" is the honest (over-broad but functional) prefix — misses cost an
    // ext_proc callout, never a bypass. Only strip when the alternatives enumerate
    // (generateCelExpression then expands one inclusion per locale).
    return "/";
  }
  const withoutLocale = withoutAnchor.replace(LEADING_LOCALE_GROUP_RE, "");
  const match = withoutLocale.match(/^(\/[a-zA-Z0-9_\-/]*)/);
  return match?.[1] ?? null;
}

// GCP validates the route-extension matchCondition.celExpression only at DEPLOY
// time — an oversized expression fails the extension update mid-deploy with no
// build-time signal. The limit is a HARD 512 characters, measured on GKE 2026-07-29:
//   INVALID_CEL_EXPRESSION: expression exceeded max length 512
// This constant was 1024 — double the real ceiling — so an expression in the 512..1024
// band built clean and then failed at cutover, which is the exact outcome the warning
// exists to prevent. See also the Service Extensions CEL matcher language reference:
// https://cloud.google.com/service-extensions/docs/cel-matcher-language-reference
export const CEL_EXPRESSION_WARN_LENGTH = 512;

export function generateCelExpression(input: CelGenerationInput): string {
  const { outputs, dynamicRoutes } = input;

  // Two constants. That is the whole function, deliberately.
  //
  // This match condition used to carry two optimizations, and both traded correctness for
  // speed:
  //
  //  - ENUMERATING the paths that need ext_proc (no-middleware apps). Under-matching silently
  //    drops PPR at the edge, and it blew GCP's hard 512-character limit at ~20 routes:
  //    app-static failed to deploy at all with INVALID_CEL_EXPRESSION (GKE, 2026-07-29).
  //  - EXCLUDING paths believed not to need it. Excluding a path a middleware matcher covers
  //    is a middleware bypass at the edge — which is why the public-file loop needed a
  //    per-file matcher probe over raw/encoded/decoded forms. The `/_next/static/` exclusion
  //    never had that probe at all: an app with `matcher: '/:path*'` had static requests
  //    excluded regardless of its middleware covering them.
  //
  // Neither optimization was ever measured, and both are worth little in practice: ext_proc
  // sits behind Cloud CDN, so a cacheable path pays at most one callout per cache lifetime.
  // Work, then correct, then fast — with no data saying these are wins, they are not worth
  // their failure modes. Nothing to enumerate means nothing to under-match; nothing to exclude
  // means nothing to mis-exclude; a constant cannot exceed a length limit.
  //
  // Restoring an exclusion later is easy and should be driven by a measurement, not a hunch.
  //
  // The extension is invoked for all methods that match. Body-capable requests (non-GET/HEAD)
  // with middleware are short-circuited at runtime by the handler's backstop (handler.ts): it
  // clears the internal dispatch headers and adds no secret, so the pool re-resolves with the
  // real body. Method is NOT gated in CEL because the extension must still run on POSTs to
  // strip client-spoofed dispatch headers — a CEL method gate would skip the callout entirely
  // and let a spoofed x-output-id reach the pool. See plans/tripwire-body-middleware-plan.md.

  // Nothing the routing service could act on: no middleware to run, no prerendered output to
  // classify, no dynamic routes. Skip the callout rather than pay for a no-op. Safe in both
  // directions — the pool re-resolves locally either way, and it always strips client-spoofed
  // dispatch headers. Conservative on purpose: ANY prerender keeps the extension, because PPR
  // routes are not separately identifiable here and losing PPR at the edge is the failure this
  // match condition exists to prevent.
  if (!outputs.middleware && outputs.prerenders.length === 0 && dynamicRoutes.length === 0) {
    return "false";
  }
  return "true";
}
