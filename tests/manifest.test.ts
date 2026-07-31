// tests/manifest.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRoutingManifest, collectOutputPathnames } from "../src/manifest.js";
import {
  mockAppPage,
  mockAppRoute,
  mockOutputs,
  mockPrerender,
  mockStaticFile,
  mockRouting,
} from "./helpers/mock-outputs.js";
import type { PoolDefinition } from "../src/types.js";
import { conditionRegex, type RouteHasCondition } from "../src/routing-common.js";

describe("collectOutputPathnames", () => {
  it("collects unique sorted pathnames from all output types", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/about" }), mockAppPage({ pathname: "/" })],
      appRoutes: [mockAppRoute({ pathname: "/api/hello" })],
      staticFiles: [mockStaticFile({ pathname: "/_next/static/chunk.js" })],
    });
    const result = collectOutputPathnames(outputs);
    expect(result).toEqual(["/", "/_next/static/chunk.js", "/about", "/api/hello"]);
  });

  it("adds the public '/' alias for the Pages Router '/index' root output", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/index" }), mockAppPage({ pathname: "/about" })],
    });
    const result = collectOutputPathnames(outputs);
    // both the internal "/index" key and the public "/" the request arrives as
    expect(result).toContain("/");
    expect(result).toContain("/index");
    expect(result).toContain("/about");
  });
});

describe("buildRoutingManifest", () => {
  // REGRESSION: middleware config.matcher must be carried into the routing
  // manifest (build-time sourceRegex -> regexp) so the ext_proc edge can gate
  // middleware. Without it the routing service runs middleware on every path.
  it("extracts middleware matchers (sourceRegex -> regexp) into the manifest", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/" })],
      middleware: {
        pathname: "/_middleware",
        filePath: "/app/.next/server/middleware.js",
        config: {
          matchers: [
            {
              source: "/only-here",
              sourceRegex: "^\\/only-here$",
              has: [{ type: "header", key: "x" }],
            },
            { source: "/other", sourceRegex: "^\\/other$", missing: [{ type: "query", key: "q" }] },
          ],
        },
      } as any,
    });
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [outputs.appPages[0]!], config: { routes: ["appPages"] } }],
    ]);
    const manifest = buildRoutingManifest({
      routing: mockRouting(),
      outputs,
      pools,
      buildId: "b",
      basePath: "",
      i18n: null,
      trailingSlash: false,
      nextVersion: "16.2.0",
      projectDir: "/app",
    } as any);
    expect(manifest.middleware?.matchers).toEqual([
      {
        regexp: "^\\/only-here$",
        has: [{ type: "header", key: "x" }],
        originalSource: "/only-here",
      },
      { regexp: "^\\/other$", missing: [{ type: "query", key: "q" }], originalSource: "/other" },
    ]);
  });

  // S11 (AVAILABILITY), build-time half. The runtime guard degrades a pathological has/missing
  // pattern to exact string comparison and warns in a pod log — correct, but it narrows middleware
  // coverage silently and in production. The shape is known at build, so the build must fail.
  // See docs/superpowers/specs/2026-07-26-smaller-open-items.md §2.
  describe("pathological has/missing patterns fail the build (S11)", () => {
    function buildWithCondition(cond: RouteHasCondition, field: "has" | "missing" = "has") {
      const outputs = mockOutputs({
        appPages: [mockAppPage({ pathname: "/" })],
        middleware: {
          pathname: "/_middleware",
          filePath: "/app/.next/server/middleware.js",
          config: {
            matchers: [{ source: "/gated", sourceRegex: "^\\/gated$", [field]: [cond] }],
          },
        } as any,
      });
      const pools = new Map<string, PoolDefinition>([
        ["ssr", { name: "ssr", outputs: [outputs.appPages[0]!], config: { routes: ["appPages"] } }],
      ]);
      return () =>
        buildRoutingManifest({
          routing: mockRouting(),
          outputs,
          pools,
          buildId: "b",
          basePath: "",
          i18n: null,
          trailingSlash: false,
          nextVersion: "16.2.0",
          projectDir: "/app",
        } as any);
    }

    it("THROWS naming the matcher, the field, the key and the pattern", () => {
      expect(buildWithCondition({ type: "header", key: "x-tier", value: "^(a+)+$" })).toThrow(
        /Middleware matcher "\/gated" has an unevaluatable has\.header condition on "x-tier": "\^\(a\+\)\+\$"/,
      );
    });

    it("explains the consequence rather than just refusing", () => {
      // The message has to say what WOULD have happened, because the failure mode it prevents
      // (exact-match degradation ⇒ middleware skipped for requests that should run it) is not
      // something an author would guess from "invalid pattern".
      expect(buildWithCondition({ type: "header", key: "x", value: "^(a+)+$" })).toThrow(
        /EXACT string comparison, silently narrowing which requests run middleware/,
      );
    });

    it("checks `missing` conditions too, not only `has`", () => {
      expect(buildWithCondition({ type: "cookie", key: "sid", value: "(x*)*" }, "missing")).toThrow(
        /unevaluatable missing\.cookie condition on "sid"/,
      );
    });

    it("rejects quantified alternation before `(a|aa)+` reaches a request value", () => {
      for (const value of ["(a|aa)+", "(aa|a)*", "((?:ab|aba)){2,}"]) {
        expect(buildWithCondition({ type: "query", key: "value", value }), value).toThrow(
          /quantified group containing alternation/,
        );
      }
    });

    it("rejects ambiguous adjacent repetitions found by bounded automaton analysis", () => {
      for (const value of ["a*a*a*a*a*b", "a.*a.*a.*a.*a.*b"]) {
        expect(buildWithCondition({ type: "header", key: "x-value", value }), value).toThrow(
          /bounded automaton analysis/,
        );
      }
    });

    it("allows a presence-only condition (no value is ever compiled)", () => {
      expect(buildWithCondition({ type: "header", key: "x-tier" })).not.toThrow();
    });

    it("allows ordinary patterns, including a single quantifier", () => {
      for (const value of ["beta", "^(beta|canary)$", "^v[0-9]+$", "a+", "^.*$"]) {
        expect(buildWithCondition({ type: "query", key: "flag", value })).not.toThrow();
      }
    });

    // The build check and the runtime guard MUST agree — a build that passes must never hit the
    // degrade path, and a build that fails must be one the runtime would have refused. Pinned by
    // running both predicates over the same corpus rather than by asserting the shared import.
    it("agrees exactly with the runtime guard over a corpus", () => {
      const corpus = [
        "beta",
        "^(beta|canary)$",
        "a+",
        "^v[0-9]+$",
        "^(a+)+$",
        "(x*)*",
        "^(ab+)+$",
        "([0-9]{2,})+",
        "(aa?)+",
        "(a|aa)+",
        "(aa|a)*",
        "((?:ab|aba)){2,}",
        "a*a*a*a*a*b",
        "a.*a.*a.*a.*a.*b",
        "[a-z]+-[0-9]+",
        "^.*$",
      ];
      for (const value of corpus) {
        const buildRejects = (() => {
          try {
            buildWithCondition({ type: "header", key: "k", value })();
            return false;
          } catch {
            return true;
          }
        })();
        // conditionRegex returns null both for "refused" and for "uncompilable"; every corpus
        // entry compiles, so null here means refused.
        const runtimeRefuses = conditionRegex(value) === null;
        expect(runtimeRefuses, `disagreement on ${JSON.stringify(value)}`).toBe(buildRejects);
      }
    });
  });

  it("generates manifest with routeGraph and pool assignments", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/" }), mockAppPage({ pathname: "/about" })],
      appRoutes: [mockAppRoute({ pathname: "/api/hello" })],
    });
    const pools = new Map<string, PoolDefinition>([
      [
        "ssr",
        {
          name: "ssr",
          outputs: [outputs.appPages[0]!, outputs.appPages[1]!],
          config: { routes: ["appPages"] },
        },
      ],
      ["api", { name: "api", outputs: [outputs.appRoutes[0]!], config: { routes: ["appRoutes"] } }],
    ]);
    const routing = mockRouting();
    const manifest = buildRoutingManifest({
      routing,
      outputs,
      pools,
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    expect(manifest.buildId).toBe("test123");
    expect(manifest.poolAssignments).toEqual({
      "/": "ssr",
      "/about": "ssr",
      "/api/hello": "api",
    });
    expect(manifest.routeGraph).toBeDefined();
    expect(manifest.pathnames).toContain("/");
    expect(manifest.pathnames).toContain("/api/hello");
  });

  it("wraps rewrite/redirect sourceRegex case-insensitively (matches next start)", () => {
    const routing = mockRouting({
      beforeFiles: [
        { source: "/redir", sourceRegex: "^\\/redir(?:\\/)?$", destination: "/dest", status: 307 },
      ],
      afterFiles: [
        { source: "/rewrite-1", sourceRegex: "^\\/rewrite-1(?:\\/)?$", destination: "/gssp" },
      ],
    });
    const manifest = buildRoutingManifest({
      routing,
      outputs: mockOutputs({}),
      pools: new Map<string, PoolDefinition>(),
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    const rg = manifest.routeGraph as {
      afterFiles: Array<{ sourceRegex: string }>;
      beforeFiles: Array<{ sourceRegex: string }>;
    };
    expect(rg.afterFiles[0]!.sourceRegex).toBe("(?i:^\\/rewrite-1(?:\\/)?$)");
    expect(rg.beforeFiles[0]!.sourceRegex).toBe("(?i:^\\/redir(?:\\/)?$)");
    // the wrapped regex matches a differently-cased request path
    expect(new RegExp(rg.afterFiles[0]!.sourceRegex).test("/Rewrite-1")).toBe(true);
    // named groups + non-source rules are untouched (idempotent, no double-wrap)
    expect(rg.afterFiles[0]!.sourceRegex.startsWith("(?i:(?i:")).toBe(false);
  });

  it("wraps ALL custom-route buckets case-insensitively, but NOT dynamicRoutes", () => {
    // Verified against upstream (see comment in manifest.ts): next start matches
    // custom routes with path-to-regexp sensitive:false but dynamic page routes
    // with a flagless RegExp (case-sensitive). @next/routing compiles everything
    // flagless — so only the custom-route buckets get the (?i:…) wrap.
    const routing = mockRouting({
      beforeMiddleware: [{ source: "/bm", sourceRegex: "^\\/bm(?:\\/)?$", destination: "/dest" }],
      beforeFiles: [{ source: "/bf", sourceRegex: "^\\/bf(?:\\/)?$", destination: "/dest" }],
      afterFiles: [{ source: "/af", sourceRegex: "^\\/af(?:\\/)?$", destination: "/dest" }],
      fallback: [{ source: "/fb", sourceRegex: "^\\/fb(?:\\/)?$", destination: "/dest" }],
      onMatch: [{ source: "/om", sourceRegex: "^\\/om(?:\\/)?$", headers: { "x-h": "1" } }],
      dynamicRoutes: [{ source: "/blog/[slug]", sourceRegex: "^\\/blog\\/([^/]+?)(?:\\/)?$" }],
    } as any);
    const manifest = buildRoutingManifest({
      routing,
      outputs: mockOutputs({}),
      pools: new Map<string, PoolDefinition>(),
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    const rg = manifest.routeGraph as Record<
      "beforeMiddleware" | "beforeFiles" | "afterFiles" | "fallback" | "onMatch" | "dynamicRoutes",
      Array<{ sourceRegex: string }>
    >;
    for (const bucket of [
      "beforeMiddleware",
      "beforeFiles",
      "afterFiles",
      "fallback",
      "onMatch",
    ] as const) {
      expect(rg[bucket][0]!.sourceRegex.startsWith("(?i:"), bucket).toBe(true);
    }
    expect(new RegExp(rg.beforeMiddleware[0]!.sourceRegex).test("/BM")).toBe(true);
    expect(new RegExp(rg.fallback[0]!.sourceRegex).test("/Fb")).toBe(true);
    expect(new RegExp(rg.onMatch[0]!.sourceRegex).test("/OM")).toBe(true);
    // dynamicRoutes: untouched, matching upstream case-sensitive page matching
    expect(rg.dynamicRoutes[0]!.sourceRegex).toBe("^\\/blog\\/([^/]+?)(?:\\/)?$");
    expect(new RegExp(rg.dynamicRoutes[0]!.sourceRegex).test("/BLOG/x")).toBe(false);
  });

  it("emits sourceRegexes that compile with new RegExp on the deploy runtime", () => {
    // N24 REGRESSION PIN: the (?i:…) wraps are inline regexp modifiers, which V8 only
    // accepts from Node 24 (the emitted containers' base image — dockerfiles.ts). Every
    // regex the manifest ships must be constructible on the runtime this suite runs on
    // (mise.toml pins Node 24); on Node 22 `new RegExp("(?i:/x)")` throws and the
    // deployed pool/routing containers would 500 every request.
    const routing = mockRouting({
      beforeMiddleware: [{ source: "/bm", sourceRegex: "^\\/bm(?:\\/)?$", destination: "/d" }],
      beforeFiles: [{ source: "/bf", sourceRegex: "^\\/bf(?:\\/)?$", destination: "/d" }],
      afterFiles: [{ source: "/af", sourceRegex: "^\\/af(?:\\/)?$", destination: "/d" }],
      fallback: [{ source: "/fb", sourceRegex: "^\\/fb(?:\\/)?$", destination: "/d" }],
      onMatch: [{ source: "/om", sourceRegex: "^\\/om(?:\\/)?$", headers: { "x-h": "1" } }],
      dynamicRoutes: [{ source: "/blog/[slug]", sourceRegex: "^\\/blog\\/([^/]+?)(?:\\/)?$" }],
    } as any);
    const manifest = buildRoutingManifest({
      routing,
      outputs: mockOutputs({
        middleware: {
          pathname: "/_middleware",
          filePath: "/app/.next/server/middleware.js",
          config: { matchers: [{ source: "/m", sourceRegex: "^\\/m$" }] },
        } as any,
      }),
      pools: new Map<string, PoolDefinition>(),
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });
    const rg = manifest.routeGraph as Record<string, Array<{ sourceRegex?: string }>>;
    const allRegexes = [
      ...["beforeMiddleware", "beforeFiles", "afterFiles", "fallback", "onMatch", "dynamicRoutes"]
        .flatMap((bucket) => rg[bucket] ?? [])
        .map((r) => r.sourceRegex),
      ...(manifest.middleware?.matchers ?? []).map((m) => m.regexp),
    ].filter((r): r is string => typeof r === "string" && r.length > 0);
    expect(allRegexes.length).toBeGreaterThanOrEqual(7);
    for (const regex of allRegexes) {
      expect(() => new RegExp(regex), regex).not.toThrow();
    }
  });

  describe("builtAt determinism (chart-regeneration invariant)", () => {
    // builtAt lands in the chart ConfigMap and every Docker context — a wall-clock
    // stamp makes byte-different charts per regeneration and busts Docker caches.
    const build = (projectDir: string) =>
      buildRoutingManifest({
        routing: mockRouting(),
        outputs: mockOutputs({}),
        pools: new Map<string, PoolDefinition>(),
        buildId: "test123",
        basePath: "",
        i18n: null,
        nextVersion: "16.2.0",
        projectDir,
      });

    let savedEpoch: string | undefined;
    beforeEach(() => {
      savedEpoch = process.env.SOURCE_DATE_EPOCH;
    });
    afterEach(() => {
      if (savedEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = savedEpoch;
    });

    it("stamps builtAt as an ISO timestamp", () => {
      delete process.env.SOURCE_DATE_EPOCH;
      const manifest = build("/app");
      expect(typeof manifest.builtAt).toBe("string");
      expect(Number.isNaN(Date.parse(manifest.builtAt))).toBe(false);
    });

    it("honors SOURCE_DATE_EPOCH (reproducible-builds standard)", () => {
      process.env.SOURCE_DATE_EPOCH = "1750000000";
      const manifest = build("/app");
      expect(manifest.builtAt).toBe(new Date(1750000000 * 1000).toISOString());
    });

    it("anchors builtAt to the .next/BUILD_ID mtime so regeneration is byte-stable", () => {
      delete process.env.SOURCE_DATE_EPOCH;
      const projectDir = mkdtempSync(path.join(os.tmpdir(), "manifest-builtat-"));
      try {
        mkdirSync(path.join(projectDir, ".next"), { recursive: true });
        writeFileSync(path.join(projectDir, ".next", "BUILD_ID"), "test123");
        const past = new Date("2026-01-02T03:04:05Z");
        utimesSync(path.join(projectDir, ".next", "BUILD_ID"), past, past);
        const first = build(projectDir).builtAt;
        const second = build(projectDir).builtAt;
        expect(first).toBe(past.toISOString());
        expect(second).toBe(first);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    // N50 (review #33): `.next` was hardcoded here too, so with a custom `distDir` the
    // BUILD_ID mtime anchor silently missed and builtAt fell back to Date.now() — the
    // manifest (embedded in the chart ConfigMap AND every Docker context) then differed on
    // every regeneration of the same build.
    it("uses ctx.distDir for the BUILD_ID anchor (custom distDir)", () => {
      delete process.env.SOURCE_DATE_EPOCH;
      const projectDir = mkdtempSync(path.join(os.tmpdir(), "manifest-distdir-"));
      try {
        const distDir = path.join(projectDir, "build");
        mkdirSync(distDir, { recursive: true });
        writeFileSync(path.join(distDir, "BUILD_ID"), "test123");
        const past = new Date("2026-02-03T04:05:06Z");
        utimesSync(path.join(distDir, "BUILD_ID"), past, past);
        const manifest = buildRoutingManifest({
          routing: mockRouting(),
          outputs: mockOutputs({}),
          pools: new Map<string, PoolDefinition>(),
          buildId: "test123",
          basePath: "",
          i18n: null,
          nextVersion: "16.2.0",
          projectDir,
          distDir,
        });
        expect(manifest.builtAt).toBe(past.toISOString());
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  it("rejects pathnames that would break out of the HTTPRoute quoted YAML scalar", () => {
    // poolAssignments keys land in gateway.ts as `path: { value: "<prefix>" }` —
    // a quote/backslash/control char in a page pathname is a chart-YAML injection.
    for (const bad of ['/evil"page', "/evil\\page", "/evil\npage"]) {
      expect(() =>
        buildRoutingManifest({
          routing: mockRouting(),
          outputs: mockOutputs({ appPages: [mockAppPage({ pathname: bad })] }),
          pools: new Map<string, PoolDefinition>(),
          buildId: "test123",
          basePath: "",
          i18n: null,
          nextVersion: "16.2.0",
          projectDir: "/app",
        }),
      ).toThrow(/Unsafe pathname/);
    }
  });

  it("assigns a prerender to its parent route's pool, not the first pool", () => {
    // Multi-pool setup: "web" is first (the default fallback pool), "blog" owns
    // the /blog/[slug] template. A concrete prerender /blog/hello must inherit
    // "blog" via its parentOutputId, not be force-assigned to "web".
    const webPage = mockAppPage({ pathname: "/", id: "/app/page" });
    const blogTemplate = mockAppPage({ pathname: "/blog/[slug]", id: "/app/blog/[slug]" });
    const outputs = mockOutputs({
      appPages: [webPage, blogTemplate],
      prerenders: [
        mockPrerender({
          pathname: "/blog/hello",
          sourcePage: "/blog/[slug]",
          // parentOutputId defaults to `/app/blog/[slug]`, matching blogTemplate.id
        }),
      ],
    });
    const pools = new Map<string, PoolDefinition>([
      ["web", { name: "web", outputs: [webPage], config: { routes: ["appPages"] } }],
      ["blog", { name: "blog", outputs: [blogTemplate], config: { routes: ["/blog/**"] } }],
    ]);
    const manifest = buildRoutingManifest({
      routing: mockRouting(),
      outputs,
      pools,
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    expect(manifest.poolAssignments["/blog/hello"]).toBe("blog");
  });

  it("detects PPR routes from prerenders", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/dashboard" })],
      prerenders: [
        mockPrerender({
          pathname: "/dashboard",
          // @ts-ignore - mock property
          parentOutputId: "/app/dashboard",
          fallback: {
            filePath: "/app/dist/dashboard.html",
            postponedState: "abc123",
          },
          config: { renderingMode: "PARTIALLY_STATIC" as any },
        }),
      ],
    });
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [outputs.appPages[0]!], config: { routes: ["appPages"] } }],
    ]);
    const manifest = buildRoutingManifest({
      routing: mockRouting(),
      outputs,
      pools,
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    expect(manifest.pprRoutes["/dashboard"]).toEqual({
      postponedState: "abc123",
      fallbackFilePath: "dist/dashboard.html",
    });
  });

  it("captures shell cache tags + revalidate/expire from fallback.initialHeaders", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/dashboard" })],
      prerenders: [
        mockPrerender({
          pathname: "/dashboard",
          // @ts-ignore - mock property
          parentOutputId: "/app/dashboard",
          fallback: {
            filePath: "/app/dist/dashboard.html",
            postponedState: "abc123",
            // @ts-ignore - mock property
            initialHeaders: { "x-next-cache-tags": "_N_T_/layout,_N_T_/page,_N_T_/dashboard" },
            initialRevalidate: 60,
            initialExpiration: 300,
          },
          config: { renderingMode: "PARTIALLY_STATIC" as any },
        }),
      ],
    });
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [outputs.appPages[0]!], config: { routes: ["appPages"] } }],
    ]);
    const manifest = buildRoutingManifest({
      routing: mockRouting(),
      outputs,
      pools,
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    expect(manifest.pprRoutes["/dashboard"]).toEqual({
      postponedState: "abc123",
      fallbackFilePath: "dist/dashboard.html",
      initialHeaders: { "x-next-cache-tags": "_N_T_/layout,_N_T_/page,_N_T_/dashboard" },
      tags: ["_N_T_/layout", "_N_T_/page", "_N_T_/dashboard"],
      revalidate: 60,
      expire: 300,
    });
  });

  it("excludes PPR routes when postponedState or filePath is missing", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/partial" })],
      prerenders: [
        mockPrerender({
          pathname: "/partial",
          // @ts-ignore - mock property
          parentOutputId: "/app/partial",
          fallback: {
            filePath: undefined,
            postponedState: undefined,
          },
          config: { renderingMode: "PARTIALLY_STATIC" as any },
        }),
      ],
    });
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [outputs.appPages[0]!], config: { routes: ["appPages"] } }],
    ]);
    const manifest = buildRoutingManifest({
      routing: mockRouting(),
      outputs,
      pools,
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    expect(manifest.pprRoutes["/partial"]).toBeUndefined();
  });

  // N16: `pprRoutes` only carries routes whose build emitted a fallback shell. A PPR-capable
  // route with `fallback: null` still answers with a postponed shell in minimal mode (measured:
  // 1705 B + `x-nextjs-postponed: 1`, no `$RC(` resume, vs `next start`'s 7973 B complete
  // document), so the pool needs a separate list. It is keyed by template with the prerender
  // manifest's `fallbackRootParams` attached, because only the root-param flavour may run
  // NON-minimal — see the RoutingManifest doc comment.
  describe("pprCapableRoutes (N16)", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-ppr-capable-"));
      mkdirSync(path.join(dir, ".next"), { recursive: true });
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function writePrerenderManifest(manifest: {
      dynamicRoutes?: Record<string, { fallbackRootParams?: unknown }>;
      routes?: Record<string, unknown>;
    }) {
      writeFileSync(
        path.join(dir, ".next", "prerender-manifest.json"),
        JSON.stringify(manifest),
        "utf-8",
      );
    }

    // N16b: the real adapter output always pairs a PARTIALLY_STATIC template with a same-`groupId`
    // `.rsc` PRERENDER sibling that carries the postponed state
    // (build-complete.js:986-991) — the sibling has a `fallback` object with NO `filePath`.
    // These helpers make the fixtures model that pairing, including DISTINCT groupIds per group:
    // `mockPrerender` otherwise defaults groupId to `sourcePage`, which would put a template and
    // its concrete generateStaticParams instances in one group and let a concrete param's
    // postponed state answer for the template.
    function template(
      pathname: string,
      groupId: number,
      overrides: Record<string, unknown> = {},
    ): ReturnType<typeof mockPrerender> {
      return mockPrerender({
        pathname,
        sourcePage: pathname,
        // @ts-ignore - mock property
        groupId,
        // @ts-ignore - mock property
        fallback: null,
        config: { renderingMode: "PARTIALLY_STATIC" as any },
        ...overrides,
      });
    }

    // The sibling upstream emits at build-complete.js:986-991: `filePath: undefined`, and
    // `postponedState: meta.postponed` — present only when the build render postponed.
    function rscSibling(
      pathname: string,
      groupId: number,
      postponedState: string | undefined,
    ): ReturnType<typeof mockPrerender> {
      return mockPrerender({
        pathname: `${pathname}.rsc`,
        sourcePage: pathname,
        // @ts-ignore - mock property
        groupId,
        fallback: { filePath: undefined, postponedState } as any,
        config: { renderingMode: "PARTIALLY_STATIC" as any },
      });
    }

    function build(prerenders: ReturnType<typeof mockPrerender>[]) {
      const outputs = mockOutputs({
        appPages: [mockAppPage({ pathname: "/x/[id]" })],
        prerenders,
      });
      const pools = new Map<string, PoolDefinition>([
        ["ssr", { name: "ssr", outputs: [outputs.appPages[0]!], config: { routes: ["appPages"] } }],
      ]);
      return buildRoutingManifest({
        routing: mockRouting(),
        outputs,
        pools,
        buildId: "test123",
        basePath: "",
        i18n: null,
        nextVersion: "16.2.0",
        projectDir: dir,
      });
    }

    it("includes a PARTIALLY_STATIC template with fallback: null, which pprRoutes omits", () => {
      writePrerenderManifest({ dynamicRoutes: { "/x/[id]": { fallbackRootParams: [] } } });
      const manifest = build([template("/x/[id]", 1), rscSibling("/x/[id]", 1, undefined)]);
      expect(manifest.pprCapableRoutes).toEqual({
        "/x/[id]": { rootParams: [], wouldPostpone: false },
      });
      expect(manifest.pprRoutes["/x/[id]"]).toBeUndefined();
    });

    // The ROOT params that stopped the build from emitting a shell travel with the entry: they
    // are the only reason the pool may run such a route non-minimal, because upstream keeps
    // unknown root branches blocking and renders a runtime shell per root-param value.
    it("carries the prerender manifest's fallbackRootParams", () => {
      writePrerenderManifest({
        dynamicRoutes: { "/[lang]/x/[id]": { fallbackRootParams: ["lang"] } },
      });
      const manifest = build([
        template("/[lang]/x/[id]", 1),
        rscSibling("/[lang]/x/[id]", 1, undefined),
      ]);
      expect(manifest.pprCapableRoutes).toEqual({
        "/[lang]/x/[id]": { rootParams: ["lang"], wouldPostpone: false },
      });
    });

    // DISJOINT from pprRoutes, not a superset: a shell-bearing entry is already driven
    // non-minimal via handlerPprInfo.
    it("EXCLUDES routes that already have a build-emitted shell (disjoint from pprRoutes)", () => {
      writePrerenderManifest({ dynamicRoutes: { "/x/[id]": { fallbackRootParams: [] } } });
      const manifest = build([
        template("/x/[id]", 1, {
          fallback: { filePath: "/app/dist/x.html", postponedState: "abc" },
        }),
        rscSibling("/x/[id]", 1, "abc"),
      ]);
      expect(manifest.pprCapableRoutes).toEqual({});
      expect(manifest.pprRoutes["/x/[id]"]).toBeDefined();
    });

    // Only prerender-manifest `dynamicRoutes` members are TEMPLATES. Concrete
    // generateStaticParams instances (`routes`) and the `.rsc`/`.segments/` flight variants are
    // PARTIALLY_STATIC with no fallback of their own; listing them flipped them to non-minimal,
    // which resumed fallback shells upstream expects NOT to be resumed
    // (app-dir/fallback-shells regressed 5 tests).
    it("excludes concrete prerenders and the .rsc / .segments/ flight variants", () => {
      writePrerenderManifest({
        dynamicRoutes: { "/x/[id]": { fallbackRootParams: [] } },
        routes: { "/x/foo": {} },
      });
      const manifest = build([
        template("/x/[id]", 1),
        rscSibling("/x/[id]", 1, undefined),
        // The concrete instance lives in its OWN group (upstream increments prerenderGroupId per
        // route), which is what keeps its postponed state out of the template's flag.
        mockPrerender({
          pathname: "/x/foo",
          sourcePage: "/x/[id]",
          // @ts-ignore - mock property
          groupId: 2,
          // @ts-ignore - mock property
          fallback: null,
          config: { renderingMode: "PARTIALLY_STATIC" as any },
        }),
        mockPrerender({
          pathname: "/x/[id].segments/_tree.segment.rsc",
          sourcePage: "/x/[id]",
          // @ts-ignore - mock property
          groupId: 1,
          // @ts-ignore - mock property
          fallback: null,
          config: { renderingMode: "PARTIALLY_STATIC" as any },
        }),
      ]);
      expect(manifest.pprCapableRoutes).toEqual({
        "/x/[id]": { rootParams: [], wouldPostpone: false },
      });
    });

    it("excludes non-PPR rendering modes", () => {
      writePrerenderManifest({ dynamicRoutes: { "/x/[id]": { fallbackRootParams: [] } } });
      const manifest = build([
        template("/x/[id]", 1, { config: { renderingMode: "STATIC" as any } }),
      ]);
      expect(manifest.pprCapableRoutes).toEqual({});
    });

    // Missing/unreadable manifest must fail toward minimal mode (pre-N16 behavior), never
    // toward "every PPR route is root-param-capable".
    it("is empty when the prerender manifest is absent", () => {
      const manifest = build([template("/x/[id]", 1)]);
      expect(manifest.pprCapableRoutes).toEqual({});
    });

    // N16b. `rootParams: []` conflated two behaviours that need OPPOSITE handling. The bit that
    // separates them is the same-groupId `.rsc` sibling's postponedState: the build suppressed
    // the shell of `/novel/early-span` only because it would have been EMPTY, yet the render DID
    // postpone — served minimal, that route returned 1,358 bytes with an empty closed
    // `<!--$--><!--/$-->` boundary where `next start` returns 7,658 bytes of resolved content.
    describe("wouldPostpone (N16b)", () => {
      it("is true when the same-groupId .rsc sibling carries a postponed state", () => {
        writePrerenderManifest({ dynamicRoutes: { "/x/[id]": { fallbackRootParams: [] } } });
        const manifest = build([template("/x/[id]", 7), rscSibling("/x/[id]", 7, "postponed-abc")]);
        expect(manifest.pprCapableRoutes).toEqual({
          "/x/[id]": { rootParams: [], wouldPostpone: true },
        });
        // Still DISJOINT from pprRoutes: there is no shell file to prepend, so nothing may be
        // injected — the whole point is that Next owns the shell lifecycle for these.
        expect(manifest.pprRoutes["/x/[id]"]).toBeUndefined();
      });

      it("is false when the sibling exists but carries no postponed state", () => {
        writePrerenderManifest({ dynamicRoutes: { "/x/[id]": { fallbackRootParams: [] } } });
        const manifest = build([template("/x/[id]", 7), rscSibling("/x/[id]", 7, undefined)]);
        expect(manifest.pprCapableRoutes).toEqual({
          "/x/[id]": { rootParams: [], wouldPostpone: false },
        });
      });

      // The `without-io` flavour as the build really emits it: the template KEEPS its shell file
      // (so `fallback` is not null) but nothing in its group ever postponed. Measured on a probe
      // app: `/i/[slug]` fallback file present + postponedState absent, sibling postponedState
      // absent. This must stay minimal (app-dir/fallback-shells).
      it("is false for a shell-bearing-but-never-postponing template (without-io shape)", () => {
        writePrerenderManifest({ dynamicRoutes: { "/x/[id]": { fallbackRootParams: [] } } });
        const manifest = build([
          template("/x/[id]", 7, {
            fallback: { filePath: "/app/dist/x.html", postponedState: undefined } as any,
          }),
          rscSibling("/x/[id]", 7, undefined),
        ]);
        expect(manifest.pprCapableRoutes).toEqual({
          "/x/[id]": { rootParams: [], wouldPostpone: false },
        });
      });

      // The join must be on groupId, never on suffix arithmetic: a postponed state belonging to a
      // DIFFERENT group — here a concrete generateStaticParams instance whose id happens to sit
      // under the same route prefix — must not answer for the template.
      it("ignores a postponed state from a different group", () => {
        writePrerenderManifest({
          dynamicRoutes: { "/x/[id]": { fallbackRootParams: [] } },
          routes: { "/x/foo": {} },
        });
        const manifest = build([
          template("/x/[id]", 7),
          rscSibling("/x/[id]", 7, undefined),
          mockPrerender({
            pathname: "/x/foo",
            sourcePage: "/x/[id]",
            // @ts-ignore - mock property
            groupId: 8,
            fallback: { filePath: "/app/dist/x/foo.html", postponedState: "concrete" },
            config: { renderingMode: "PARTIALLY_STATIC" as any },
          }),
          rscSibling("/x/foo", 8, "concrete"),
        ]);
        expect(manifest.pprCapableRoutes).toEqual({
          "/x/[id]": { rootParams: [], wouldPostpone: false },
        });
      });

      // Prerequisite-2 finding, pinned: two CONCRETE params of one template can disagree about
      // postponing (measured on a probe app — `/h/dyn` postponed, `/h/stat` did not). That does
      // NOT make the per-template flag wrong, because each concrete param sits in its own group
      // and is answered by its own artifact; the template's flag describes only the template
      // render, which is the only evidence available for a param with no build artifact.
      it("is unaffected by concrete params that disagree about postponing", () => {
        writePrerenderManifest({
          dynamicRoutes: { "/x/[id]": { fallbackRootParams: [] } },
          routes: { "/x/dyn": {}, "/x/stat": {} },
        });
        const manifest = build([
          template("/x/[id]", 7),
          rscSibling("/x/[id]", 7, "template-postponed"),
          mockPrerender({
            pathname: "/x/dyn",
            sourcePage: "/x/[id]",
            // @ts-ignore - mock property
            groupId: 8,
            fallback: { filePath: "/app/dist/x/dyn.html", postponedState: "dyn-postponed" },
            config: { renderingMode: "PARTIALLY_STATIC" as any },
          }),
          rscSibling("/x/dyn", 8, "dyn-postponed"),
          mockPrerender({
            pathname: "/x/stat",
            sourcePage: "/x/[id]",
            // @ts-ignore - mock property
            groupId: 9,
            fallback: { filePath: "/app/dist/x/stat.html", postponedState: undefined } as any,
            config: { renderingMode: "PARTIALLY_STATIC" as any },
          }),
          rscSibling("/x/stat", 9, undefined),
        ]);
        // Only the template is keyed; both concrete params keep their own artifacts.
        expect(manifest.pprCapableRoutes).toEqual({
          "/x/[id]": { rootParams: [], wouldPostpone: true },
        });
        expect(manifest.pprRoutes["/x/dyn"]).toBeDefined();
        expect(manifest.pprRoutes["/x/stat"]).toBeUndefined();
      });

      // The build-time assertion. Losing the sibling upstream would silently reclassify every
      // shell-less PPR template as "never postpones" and bring the truncation back, so it must be
      // a loud build failure instead.
      // N16c: this used to THROW, to protect the `wouldPostpone` signal. The signal turned out
      // not to discriminate (see the N16c notes in manifest.ts and the minimalMode gate), so
      // nothing load-bearing consumes it and a hard throw could only fail builds for no benefit.
      // A missing sibling now classifies as "does not postpone" and the build proceeds.
      it("does NOT throw when a PARTIALLY_STATIC template has no same-groupId .rsc sibling", () => {
        writePrerenderManifest({ dynamicRoutes: { "/x/[id]": { fallbackRootParams: [] } } });
        const manifest = build([template("/x/[id]", 7)]);
        expect(manifest.pprCapableRoutes?.["/x/[id]"]?.wouldPostpone).toBe(false);
      });

      // A same-group member that is NOT the sibling does not satisfy the assertion: segment
      // prerenders share the groupId but carry their own fallback FILE and hardcode
      // `postponedState: undefined` (build-complete.js:634).
      // N16c: both of these used to THROW for the same reason as above, and no longer do.
      // Kept as regression cover that a missing/segment-only sibling is CLASSIFIED (as
      // not-postponing) rather than fatal.
      it("classifies rather than throws when the only same-group members are segment prerenders", () => {
        writePrerenderManifest({ dynamicRoutes: { "/x/[id]": { fallbackRootParams: [] } } });
        const manifest = build([
          template("/x/[id]", 7),
          mockPrerender({
            pathname: "/x/[id].segments/_tree.segment.rsc",
            sourcePage: "/x/[id]",
            // @ts-ignore - mock property
            groupId: 7,
            fallback: { filePath: "/app/dist/x/_tree.segment.rsc", postponedState: undefined },
            config: { renderingMode: "PARTIALLY_STATIC" as any },
          }),
        ]);
        expect(manifest.pprCapableRoutes?.["/x/[id]"]?.wouldPostpone).toBe(false);
      });

      it("does not throw for a shell-bearing PARTIALLY_STATIC template with no sibling", () => {
        writePrerenderManifest({ dynamicRoutes: { "/x/[id]": { fallbackRootParams: [] } } });
        expect(() =>
          build([
            template("/x/[id]", 7, {
              fallback: { filePath: "/app/dist/x.html", postponedState: "abc" },
            }),
          ]),
        ).not.toThrow();
      });

      // The assertion covers the shell-BEARING flavour too: it is the same upstream contract, and
      // a break there is the earliest signal that the discriminator is gone.
      // Concrete instances and `.segments/` variants are NOT prerender-manifest `dynamicRoutes`
      // members, so the assertion must not fire for them — they legitimately have no sibling of
      // their own in some builds, and an over-broad assertion would break every build.
      it("does not assert on outputs that are not route templates", () => {
        writePrerenderManifest({
          dynamicRoutes: { "/x/[id]": { fallbackRootParams: [] } },
          routes: { "/x/foo": {} },
        });
        const manifest = build([
          template("/x/[id]", 7),
          rscSibling("/x/[id]", 7, undefined),
          mockPrerender({
            pathname: "/x/foo",
            sourcePage: "/x/[id]",
            // @ts-ignore - mock property
            groupId: 8,
            // @ts-ignore - mock property
            fallback: null,
            config: { renderingMode: "PARTIALLY_STATIC" as any },
          }),
        ]);
        expect(manifest.pprCapableRoutes).toEqual({
          "/x/[id]": { rootParams: [], wouldPostpone: false },
        });
      });
    });
  });

  it("places rsc inside routeGraph", () => {
    const outputs = mockOutputs({ appPages: [mockAppPage({ pathname: "/" })] });
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [outputs.appPages[0]!], config: { routes: ["appPages"] } }],
    ]);
    const manifest = buildRoutingManifest({
      routing: mockRouting(),
      outputs,
      pools,
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    expect(manifest.routeGraph.rsc).toBeDefined();
    expect(manifest.routeGraph.rsc.header).toBe("RSC");
    expect((manifest as any).rsc).toBeUndefined();
  });
});

// Survey Tier 2 #7 (plans/lessons-from-sibling-adapters.md): the build emits PARTIALLY_STATIC
// PRERENDER outputs whose fallback carries a postponedState but NO filePath — the shell-less
// `.rsc` postponed-state siblings (dynamic-RSC prefetch responses for PPR routes,
// build-complete.js:986-991). `pprRoutes` deliberately requires a shell and `pprCapableRoutes`
// only admits route TEMPLATES (prerender-manifest dynamicRoutes members), so these outputs were
// dropped from the manifest entirely — the resume implementation cannot see them. The Vercel
// adapter registers them gated on `allowQuery.length === 0` (outputs.ts:652-673): with no
// route-param variance the postponed state is shareable across requests; with params it is not
// and must cold-render.
describe("pprStatePrerenders (survey Tier 2 #7)", () => {
  function manifestWith(prerender: Record<string, unknown>) {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/novel" })],
      prerenders: [mockPrerender(prerender as any)],
    });
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [outputs.appPages[0]!], config: { routes: ["appPages"] } }],
    ]);
    return buildRoutingManifest({
      routing: mockRouting(),
      outputs,
      pools,
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });
  }

  it("registers a filePath-less postponed-state prerender when allowQuery is empty", () => {
    const manifest = manifestWith({
      pathname: "/novel.rsc",
      groupId: 7,
      fallback: { postponedState: "ppr-state-bytes" },
      config: { renderingMode: "PARTIALLY_STATIC" as any, allowQuery: [] },
    });
    expect((manifest as any).pprStatePrerenders).toEqual({
      "/novel.rsc": { postponedState: "ppr-state-bytes" },
    });
    // Disjoint from the shell-bearing map — nothing here has a shell to serve.
    expect(manifest.pprRoutes["/novel.rsc"]).toBeUndefined();
  });

  it("refuses one whose allowQuery names route params (state is param-dependent, must cold-render)", () => {
    const manifest = manifestWith({
      pathname: "/novel/[id].rsc",
      groupId: 8,
      fallback: { postponedState: "param-dependent-state" },
      config: { renderingMode: "PARTIALLY_STATIC" as any, allowQuery: ["id"] },
    });
    expect((manifest as any).pprStatePrerenders ?? {}).toEqual({});
  });

  it("refuses one with no allowQuery at all (variance unknown — conservative)", () => {
    const manifest = manifestWith({
      pathname: "/novel.rsc",
      groupId: 9,
      fallback: { postponedState: "state" },
      config: { renderingMode: "PARTIALLY_STATIC" as any },
    });
    expect((manifest as any).pprStatePrerenders ?? {}).toEqual({});
  });

  it("leaves shell-bearing prerenders in pprRoutes only", () => {
    const manifest = manifestWith({
      pathname: "/dashboard",
      groupId: 10,
      fallback: { filePath: "/app/dist/dashboard.html", postponedState: "abc" },
      config: { renderingMode: "PARTIALLY_STATIC" as any, allowQuery: [] },
    });
    expect(manifest.pprRoutes["/dashboard"]).toBeDefined();
    expect((manifest as any).pprStatePrerenders ?? {}).toEqual({});
  });
});

// Matrix iteration 4 (plans/prerender-matrix-catchup.md): the platform cache key must
// exclude never-enumerable params, and `config.allowQuery` is the build's own statement of
// which params PARTITION the key. Emit it on both PPR maps so dispatch can compute keys.
describe("allowQuery on PPR manifest entries (matrix key registry)", () => {
  it("carries allowQuery on shell-bearing pprRoutes entries", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/m/[lang]/[id]" })],
      prerenders: [
        mockPrerender({
          pathname: "/m/[lang]/[id]",
          fallback: { filePath: "/app/dist/m.html", postponedState: "st" },
          config: {
            renderingMode: "PARTIALLY_STATIC" as any,
            allowQuery: ["lang"],
          },
        }),
      ],
    });
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [outputs.appPages[0]!], config: { routes: ["appPages"] } }],
    ]);
    const manifest = buildRoutingManifest({
      routing: mockRouting(),
      outputs,
      pools,
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });
    expect((manifest.pprRoutes["/m/[lang]/[id]"] as any)?.allowQuery).toEqual(["lang"]);
  });
});
