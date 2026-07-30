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
  /**
   * Pathnames of the app's `public/` files (`collectPublicPathnames(projectDir)`).
   *
   * N40: the per-file exclusion loop below iterated `outputs.staticFiles`, which for a real
   * build holds ONLY build outputs and `/_next/static/*` — Next never enumerates `public/` as
   * an adapter output (that is exactly why `collectPublicPathnames` exists, and why the
   * static-asset manifest and the pool's pathname set both call it). MEASURED on
   * `fixtures/main`, whose matcher explicitly excludes `cdn-probe.txt` and
   * `header-priority.txt`: the emitted expression was
   * `!(request.path.startsWith('/_next/static/'))` — zero per-file exclusions. So the
   * documented percent-encoding machinery never ran on a public file and
   * `warnIfOversized`'s advice ("reduce the number of public files not covered by
   * middleware") was unactionable.
   *
   * Optional: absent ⇒ the loop sees only `outputs.staticFiles`, i.e. exactly the previous
   * behavior, so a caller that has no projectDir is unaffected.
   */
  publicPathnames?: string[];
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

/**
 * An exact-path CEL term that is correct whether or not `request.path` carries the query string.
 *
 * N40. GCP's CEL matcher language reference
 * (https://cloud.google.com/service-extensions/docs/cel-matcher-language-reference) documents
 * `request.path` as "The requested HTTP URL path" and lists `request.query` separately — and it
 * does NOT document `request.url_path` at all (the documented `request.*` set is headers, method,
 * host, path, query, scheme, backend_service_name, backend_service_project_number). Envoy, which
 * these attributes come from, documents `request.path` as "The path portion of the URL" and
 * `request.url_path` as "The path portion of the URL **without the query string**"
 * (https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/advanced/attributes) — i.e.
 * upstream `request.path` DOES include the query, and the attribute that strips it is the one
 * GCP does not expose. Using `request.url_path` would risk the match condition being rejected
 * when the extension is updated — a mid-deploy failure, which is the exact class
 * `CEL_EXPRESSION_WARN_LENGTH` exists to avoid.
 *
 * So: stay inside the documented attribute set and accept BOTH readings. Under the path-only
 * reading the second term can never fire (a path cannot contain a raw `?`); under the
 * path-plus-query reading it catches `/file.txt?x=1`, which a bare `==` silently missed. Both
 * directions were already fail-safe (a missed exclusion costs one ext_proc callout; a missed
 * inclusion falls through to the pool's local resolver), so this is a hit-rate fix, not a
 * correctness one — and it is pinned by a test rather than left to the next reader to rediscover.
 */
function celPathEquals(wirePath: string): string {
  const literal = escapeCelString(wirePath);
  return `(request.path == '${literal}' || request.path.startsWith('${literal}?'))`;
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

function warnIfOversized(expr: string): string {
  if (expr.length > CEL_EXPRESSION_WARN_LENGTH) {
    console.warn(
      `[adapter-k8s] Generated CEL match condition is ${expr.length} characters, over the ` +
        `${CEL_EXPRESSION_WARN_LENGTH}-character budget for GCP Service Extensions match ` +
        `conditions — the route-extension update may be rejected at deploy time. Reduce the ` +
        `number of public/ files NOT covered by the middleware matcher (each one emits an ` +
        `exclusion; widening the matcher to cover them removes it) or consolidate dynamic ` +
        `route prefixes.`,
    );
  }
  return expr;
}

export function generateCelExpression(input: CelGenerationInput): string {
  const { outputs, dynamicRoutes, basePath = "", publicPathnames = [] } = input;
  const exclusions: string[] = [];

  exclusions.push(`request.path.startsWith('${escapeCelString(`${basePath}/_next/static/`)}')`);

  const middlewareMatchers = (outputs.middleware as any)?.config?.matchers ?? [];
  // N40: `outputs.staticFiles` carries build outputs (and `/_next/static/*`), never `public/`
  // files — those are staged separately and enumerated by `collectPublicPathnames`. Union both
  // so the loop below actually sees the files its comment and the oversize warning describe.
  const publicFiles = [
    ...new Set([
      ...outputs.staticFiles
        .filter((f) => !f.pathname.startsWith("/_next/"))
        .map((f) => f.pathname),
      ...publicPathnames.filter((p) => !p.startsWith("/_next/")),
    ]),
  ].sort();

  for (const publicPath of publicFiles) {
    // The wire path (and the compiled middleware matcher) carries the basePath,
    // so the middleware-coverage probe must too.
    const wirePath = `${basePath}${publicPath}`;
    // Runtime matchesMiddleware (routing-common.ts) tests BOTH the raw (encoded)
    // pathname and its decoded form — this build-time probe must be at least as
    // generous, or a middleware-covered file gets an exact-match exclusion and
    // bypasses ext_proc (and middleware) entirely at the edge.
    const probePaths = new Set([wirePath, percentEncodePath(wirePath)]);
    try {
      probePaths.add(decodeURIComponent(wirePath));
    } catch {
      // not percent-encoded — raw + encoded forms suffice
    }
    const matchedByMiddleware = middlewareMatchers.some((m: { sourceRegex: string }) => {
      let re: RegExp;
      try {
        re = new RegExp(m.sourceRegex);
      } catch {
        // FAIL SAFE: a matcher source that doesn't compile at build time (regex
        // engine skew, hand-written matcher) MIGHT cover this file. Treat it as
        // covered so the file stays behind ext_proc — the cost is one callout per
        // request; the alternative (an exact-match exclusion) is a middleware
        // bypass at the edge. Mirrors the runtime fail-safe in routing-common.ts.
        return true;
      }
      return [...probePaths].some((p) => re.test(p));
    });
    if (!matchedByMiddleware) {
      exclusions.push(celPathEquals(wirePath));
    }
  }

  if (!outputs.middleware) {
    const inclusions: string[] = [];
    for (const route of dynamicRoutes) {
      const staticPrefix = extractStaticPrefix(route.sourceRegex);
      if (staticPrefix) {
        // A locale-prefixed route matches /en/blog/…, /fr/blog/… — never the bare
        // /blog/…. Expand one inclusion per enumerable locale so the CEL fires for
        // the paths that actually arrive; non-enumerable groups keep the bare
        // prefix (fail-safe: misses fall through to the pool's local resolver).
        const locales = leadingLocaleAlternatives(route.sourceRegex);
        if (locales) {
          for (const locale of locales) {
            inclusions.push(
              `request.path.startsWith('${escapeCelString(`${basePath}/${locale}${staticPrefix}`)}')`,
            );
          }
        } else {
          inclusions.push(
            `request.path.startsWith('${escapeCelString(`${basePath}${staticPrefix}`)}')`,
          );
        }
      }
    }
    for (const prerender of outputs.prerenders) {
      const fallback = prerender.fallback as Record<string, unknown> | undefined;
      if (fallback?.initialRevalidate) {
        inclusions.push(celPathEquals(`${basePath}${prerender.pathname}`));
      }
    }
    if (inclusions.length === 0) return "false";
    inclusions.push(`request.path.startsWith('${escapeCelString(`${basePath}/_next/image`)}')`);
    return warnIfOversized(inclusions.join(" || "));
  }

  // The extension is invoked for all methods that match. Body-capable requests (non-GET/HEAD)
  // with middleware are short-circuited at runtime by the handler's backstop (handler.ts): it
  // clears the internal dispatch headers and adds no secret, so the pool re-resolves with the
  // real body. Method is NOT gated in CEL because the extension must still run on POSTs to
  // strip client-spoofed dispatch headers — a CEL method gate would skip the callout entirely
  // and let a spoofed x-output-id reach the pool. See plans/tripwire-body-middleware-plan.md.
  if (exclusions.length === 0) return "true";
  return warnIfOversized(`!(${exclusions.join(" || ")})`);
}
