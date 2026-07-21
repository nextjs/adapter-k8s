import type { AdapterOutputs } from "./types.js";
import type { Route } from "@next/routing";

export interface CelGenerationInput {
  outputs: AdapterOutputs;
  dynamicRoutes: Route[];
}

/** Escape a value for safe interpolation into a CEL single-quoted string literal. */
export function escapeCelString(value: string): string {
  // The escaped text is later embedded in a YAML scalar (route-extension.yaml) where a
  // control character (e.g. a newline in a public filename) would silently fold and
  // corrupt the extension spec — reject anything outside printable ASCII at build time.
  if (/[^\x20-\x7e]/.test(value)) {
    throw new Error(
      `Cannot embed ${JSON.stringify(value)} in the CEL match condition: ` +
        `control/non-ASCII characters are not supported (they would corrupt the ` +
        `route-extension YAML). Rename the file to printable ASCII.`,
    );
  }
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function extractStaticPrefix(sourceRegex: string): string | null {
  const withoutAnchor = sourceRegex.replace(/^\^/, "");
  const match = withoutAnchor.match(/^(\/[a-zA-Z0-9_\-/]*)/);
  return match?.[1] ?? null;
}

export function generateCelExpression(input: CelGenerationInput): string {
  const { outputs, dynamicRoutes } = input;
  const exclusions: string[] = [];

  exclusions.push("request.path.startsWith('/_next/static/')");

  const middlewareMatchers = (outputs.middleware as any)?.config?.matchers ?? [];
  const publicFiles = outputs.staticFiles
    .filter((f) => !f.pathname.startsWith("/_next/"))
    .map((f) => f.pathname);

  for (const publicPath of publicFiles) {
    const matchedByMiddleware = middlewareMatchers.some((m: { sourceRegex: string }) => {
      try {
        return new RegExp(m.sourceRegex).test(publicPath);
      } catch {
        return false;
      }
    });
    if (!matchedByMiddleware) {
      exclusions.push(`request.path == '${escapeCelString(publicPath)}'`);
    }
  }

  if (!outputs.middleware) {
    const inclusions: string[] = [];
    for (const route of dynamicRoutes) {
      const staticPrefix = extractStaticPrefix(route.sourceRegex);
      if (staticPrefix) {
        inclusions.push(`request.path.startsWith('${escapeCelString(staticPrefix)}')`);
      }
    }
    for (const prerender of outputs.prerenders) {
      const fallback = prerender.fallback as Record<string, unknown> | undefined;
      if (fallback?.initialRevalidate) {
        inclusions.push(`request.path == '${escapeCelString(prerender.pathname)}'`);
      }
    }
    if (inclusions.length === 0) return "false";
    inclusions.push("request.path.startsWith('/_next/image')");
    return inclusions.join(" || ");
  }

  // The extension is invoked for all methods that match. Body-capable requests (non-GET/HEAD)
  // with middleware are short-circuited at runtime by the handler's backstop (handler.ts): it
  // clears the internal dispatch headers and adds no secret, so the pool re-resolves with the
  // real body. Method is NOT gated in CEL because the extension must still run on POSTs to
  // strip client-spoofed dispatch headers — a CEL method gate would skip the callout entirely
  // and let a spoofed x-output-id reach the pool. See plans/tripwire-body-middleware-plan.md.
  if (exclusions.length === 0) return "true";
  return `!(${exclusions.join(" || ")})`;
}
