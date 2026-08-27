export interface CacheControlDirective {
  name: string;
  value: string | null;
}

const CACHE_CONTROL_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Parse Cache-Control as a comma-delimited directive list, keeping commas inside quoted strings.
 *
 * Security decisions must compare exact directive names: word-boundary searches make extension
 * names such as `x-no-store` and `x-s-maxage` indistinguishable from the standard directives.
 * Malformed members are ignored rather than partially interpreted. That is fail-closed for both
 * consumers below: malformed vetoes cannot weaken a forced cache policy, while malformed
 * freshness extensions cannot invent a cache window.
 */
export function parseCacheControlDirectives(cacheControl: string): CacheControlDirective[] {
  const members: string[] = [];
  let memberStart = 0;
  let quoted = false;
  let escaped = false;

  for (let i = 0; i < cacheControl.length; i++) {
    const ch = cacheControl[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      members.push(cacheControl.slice(memberStart, i));
      memberStart = i + 1;
    }
  }
  members.push(cacheControl.slice(memberStart));

  const directives: CacheControlDirective[] = [];
  for (const rawMember of members) {
    const member = rawMember.trim();
    if (!member) continue;
    const equals = member.indexOf("=");
    const rawName = (equals === -1 ? member : member.slice(0, equals)).trim();
    if (!CACHE_CONTROL_TOKEN_RE.test(rawName)) continue;
    if (equals === -1) {
      directives.push({ name: rawName.toLowerCase(), value: null });
      continue;
    }

    const rawValue = member.slice(equals + 1).trim();
    let value: string;
    if (rawValue.startsWith('"')) {
      let end = -1;
      let quotedEscape = false;
      for (let i = 1; i < rawValue.length; i++) {
        const ch = rawValue[i]!;
        if (quotedEscape) quotedEscape = false;
        else if (ch === "\\") quotedEscape = true;
        else if (ch === '"') {
          end = i;
          break;
        }
      }
      if (end === -1 || rawValue.slice(end + 1).trim() !== "") continue;
      value = rawValue.slice(1, end).replace(/\\([\t !-~\u0080-\u00ff])/g, "$1");
    } else {
      if (!CACHE_CONTROL_TOKEN_RE.test(rawValue)) continue;
      value = rawValue;
    }
    directives.push({ name: rawName.toLowerCase(), value });
  }
  return directives;
}

export function hasUnqualifiedCacheControlDirective(cacheControl: string, name: string): boolean {
  const normalizedName = name.toLowerCase();
  return parseCacheControlDirectives(cacheControl).some(
    (directive) => directive.name === normalizedName && directive.value === null,
  );
}

/**
 * True when this Cache-Control gives a SHARED cache a window in which it may serve hits without
 * revalidating, with neither unqualified `no-store`, `no-cache` nor `private` to veto storage.
 * The single derivation for the middleware invariant (pool-server/cache-policy.ts), the
 * RSC-validation invariant (routing-service/handler.ts), and deploy cache tagging (cdn-tags.ts).
 *
 * Three independent grants, any one of which opens the window:
 *  - a positive `s-maxage` (else `max-age`) — the plain freshness lifetime;
 *  - a positive RFC 5861 `stale-while-revalidate` — grants the cache permission to serve a STALE
 *    hit while it revalidates in the background, i.e. an unrevalidated hit, and it does so
 *    INDEPENDENTLY of `max-age`. `max-age=0, stale-while-revalidate=600` therefore gave a shared
 *    cache a 600-second unrevalidated window while passing both original consumers: the N18 RSC
 *    guard left an unvalidated RSC response storable, and the pool's middleware invariant saw an
 *    "explicit safe policy" that isn't one. It also passed the old CDN tag regex, so cutover
 *    could not invalidate that shared entry;
 *  - a positive RFC 5861 `stale-if-error` — same shape for the error case.
 * `max-age=0` alone still returns false: that is a revalidate-every-time policy, which is what
 * the middleware invariant wants.
 */
export function grantsSharedCacheFreshness(cacheControl: string): boolean {
  const directives = parseCacheControlDirectives(cacheControl);
  const hasUnqualified = (name: string): boolean =>
    directives.some((directive) => directive.name === name && directive.value === null);
  // S24. Only the UNQUALIFIED no-cache/private forms veto the whole response. RFC 9111 also
  // permits field-name arguments, whose remaining response can still be served fresh.
  if (hasUnqualified("no-store") || hasUnqualified("no-cache") || hasUnqualified("private")) {
    return false;
  }

  const values = (name: string): string[] =>
    directives
      .filter(
        (directive): directive is CacheControlDirective & { value: string } =>
          directive.name === name && directive.value !== null,
      )
      .map((directive) => directive.value);
  const grantsPositiveSeconds = (name: string): boolean =>
    values(name).some((value) => /^\d+$/.test(value) && Number(value) > 0);

  // s-maxage overrides max-age for shared caches. Duplicate directives make the field invalid;
  // treating any positive duplicate as a grant is the safe interpretation for this guard.
  const sMaxAge = values("s-maxage");
  if (sMaxAge.length > 0) {
    if (sMaxAge.some((value) => /^\d+$/.test(value) && Number(value) > 0)) return true;
  } else if (grantsPositiveSeconds("max-age")) {
    return true;
  }
  return grantsPositiveSeconds("stale-while-revalidate") || grantsPositiveSeconds("stale-if-error");
}
