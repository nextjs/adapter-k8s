import type { AdapterOutputs } from './types.js';
import type { Route } from '@next/routing';

export interface CelGenerationInput {
  outputs: AdapterOutputs;
  dynamicRoutes: Route[];
}

export function extractStaticPrefix(sourceRegex: string): string | null {
  const withoutAnchor = sourceRegex.replace(/^\^/, '');
  const match = withoutAnchor.match(/^(\/[a-zA-Z0-9_\-/]*)/);
  return match?.[1] ?? null;
}

export function generateCelExpression(input: CelGenerationInput): string {
  const { outputs, dynamicRoutes } = input;
  const exclusions: string[] = [];

  exclusions.push("request.path.startsWith('/_next/static/')");

  const middlewareMatchers = (outputs.middleware as any)?.config?.matchers ?? [];
  const publicFiles = outputs.staticFiles
    .filter(f => !f.pathname.startsWith('/_next/'))
    .map(f => f.pathname);

  for (const publicPath of publicFiles) {
    const matchedByMiddleware = middlewareMatchers.some(
      (m: { sourceRegex: string }) => {
        try { return new RegExp(m.sourceRegex).test(publicPath); }
        catch { return false; }
      }
    );
    if (!matchedByMiddleware) {
      exclusions.push(`request.path == '${publicPath}'`);
    }
  }

  if (!outputs.middleware) {
    const inclusions: string[] = [];
    for (const route of dynamicRoutes) {
      const staticPrefix = extractStaticPrefix(route.sourceRegex);
      if (staticPrefix) {
        inclusions.push(`request.path.startsWith('${staticPrefix}')`);
      }
    }
    for (const prerender of outputs.prerenders) {
      const fallback = prerender.fallback as Record<string, unknown> | undefined;
      if (fallback?.initialRevalidateSeconds) {
        inclusions.push(`request.path == '${prerender.pathname}'`);
      }
    }
    if (inclusions.length === 0) return 'false';
    inclusions.push("request.path.startsWith('/_next/image')");
    return inclusions.join(' || ');
  }

  if (exclusions.length === 0) return 'true';
  return `!(${exclusions.join(' || ')})`;
}
