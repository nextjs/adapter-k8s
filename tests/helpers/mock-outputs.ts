// tests/helpers/mock-outputs.ts
import type { AdapterOutput, AdapterOutputs, BuildCompleteContext } from "../../src/types.js";

export function mockAppPage(
  overrides: Partial<AdapterOutput["APP_PAGE"]> = {},
): AdapterOutput["APP_PAGE"] {
  return {
    id: overrides.id ?? `/app${overrides.pathname ?? "/page"}`,
    filePath: overrides.filePath ?? `/dist/server/app${overrides.pathname ?? "/page"}.js`,
    pathname: overrides.pathname ?? "/page",
    sourcePage: overrides.sourcePage ?? "/page",
    runtime: overrides.runtime ?? "nodejs",
    assets: overrides.assets ?? {},
    type: 4 as any, // AdapterOutputType.APP_PAGE
    config: overrides.config ?? {},
  };
}

export function mockAppRoute(
  overrides: Partial<AdapterOutput["APP_ROUTE"]> = {},
): AdapterOutput["APP_ROUTE"] {
  return {
    id: overrides.id ?? `/app${overrides.pathname ?? "/api/hello"}`,
    filePath: overrides.filePath ?? `/dist/server/app${overrides.pathname ?? "/api/hello"}.js`,
    pathname: overrides.pathname ?? "/api/hello",
    sourcePage: overrides.sourcePage ?? "/api/hello",
    runtime: overrides.runtime ?? "nodejs",
    assets: overrides.assets ?? {},
    type: 5 as any, // AdapterOutputType.APP_ROUTE
    config: overrides.config ?? {},
  };
}

export function mockStaticFile(
  overrides: Partial<AdapterOutput["STATIC_FILE"]> = {},
): AdapterOutput["STATIC_FILE"] {
  return {
    id: overrides.id ?? `static:${overrides.pathname ?? "/_next/static/chunk.js"}`,
    filePath: overrides.filePath ?? `/dist${overrides.pathname ?? "/_next/static/chunk.js"}`,
    pathname: overrides.pathname ?? "/_next/static/chunk.js",
    type: 7 as any, // AdapterOutputType.STATIC_FILE
  };
}

export function mockPrerender(
  overrides: Partial<AdapterOutput["PRERENDER"]> = {},
): AdapterOutput["PRERENDER"] {
  return {
    id: overrides.id ?? `prerender:${overrides.pathname ?? "/blog/post"}`,
    filePath: overrides.filePath ?? `/dist/server/pages${overrides.pathname ?? "/blog/post"}.html`,
    pathname: overrides.pathname ?? "/blog/post",
    sourcePage: overrides.sourcePage ?? "/blog/[slug]",
    type: 6 as any, // AdapterOutputType.PRERENDER
    config: overrides.config ?? {},
    // @ts-ignore
    fallback: overrides.fallback,
    // @ts-ignore
    parentOutputId: overrides.parentOutputId ?? `/app${overrides.sourcePage ?? "/blog/[slug]"}`,
    // @ts-ignore
    groupId: overrides.groupId ?? overrides.sourcePage ?? "/blog/[slug]",
  };
}

export function mockOutputs(overrides: Partial<AdapterOutputs> = {}): AdapterOutputs {
  return {
    appPages: overrides.appPages ?? [],
    appRoutes: overrides.appRoutes ?? [],
    pages: overrides.pages ?? [],
    pagesApi: overrides.pagesApi ?? [],
    prerenders: overrides.prerenders ?? [],
    staticFiles: overrides.staticFiles ?? [],
    middleware: overrides.middleware ?? undefined,
  };
}

export function mockRouting(
  overrides: Partial<BuildCompleteContext["routing"]> = {},
): BuildCompleteContext["routing"] {
  return {
    beforeMiddleware: overrides.beforeMiddleware ?? [],
    beforeFiles: overrides.beforeFiles ?? [],
    afterFiles: overrides.afterFiles ?? [],
    dynamicRoutes: overrides.dynamicRoutes ?? [],
    onMatch: overrides.onMatch ?? [],
    fallback: overrides.fallback ?? [],
    shouldNormalizeNextData: overrides.shouldNormalizeNextData ?? false,
    rsc: overrides.rsc ?? {
      header: "RSC",
      varyHeader: "RSC, Next-Router-State-Tree, Next-Router-Prefetch",
      contentType: "text/x-component",
      suffix: ".rsc",
      prefetchHeader: "Next-Router-Prefetch",
      didPostponeHeader: "x-nextjs-postponed",
    },
  };
}
