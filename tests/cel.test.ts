import { describe, it, expect } from "vitest";
import { generateCelExpression, extractStaticPrefix } from "../src/cel.js";
import {
  mockOutputs,
  mockStaticFile,
  mockPrerender,
  mockAppPage,
  mockAppRoute,
} from "./helpers/mock-outputs.js";

describe("extractStaticPrefix", () => {
  it("extracts prefix from dynamic route regex", () => {
    expect(extractStaticPrefix("^/blog/([^/]+?)(?:/)?$")).toBe("/blog/");
  });
  it("extracts prefix from nested dynamic route", () => {
    expect(extractStaticPrefix("^/api/users/([^/]+?)/posts(?:/)?$")).toBe("/api/users/");
  });
  it("returns null for root-level dynamic route", () => {
    expect(extractStaticPrefix("^/([^/]+?)(?:/)?$")).toBe("/");
  });
  it("returns null for unparseable regex", () => {
    expect(extractStaticPrefix("(?:)")).toBeNull();
  });
});

describe("generateCelExpression", () => {
  it("generates exclusion list when middleware exists", () => {
    const outputs = mockOutputs({
      staticFiles: [
        mockStaticFile({ pathname: "/favicon.ico" }),
        mockStaticFile({ pathname: "/robots.txt" }),
      ],
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: { matchers: [] },
      } as any,
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toContain("request.path.startsWith('/_next/static/')");
    expect(cel).toContain("request.path == '/favicon.ico'");
    expect(cel).toContain("request.path == '/robots.txt'");
    // Method is NOT gated in CEL: the extension must run on POSTs too, so it can strip
    // client-spoofed dispatch headers. Body-capable requests with middleware are short-
    // circuited at runtime by the handler backstop, not by the CEL match condition.
    expect(cel).toMatch(/^!\(/);
    expect(cel).not.toContain("request.method");
  });

  it("does not exclude public files matched by middleware matchers", () => {
    const outputs = mockOutputs({
      staticFiles: [
        mockStaticFile({ pathname: "/favicon.ico" }),
        mockStaticFile({ pathname: "/api-docs.html" }),
      ],
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: { matchers: [{ sourceRegex: "^/api-docs.*$" }] },
      } as any,
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toContain("request.path == '/favicon.ico'");
    expect(cel).not.toContain("api-docs");
  });

  it("generates inclusion list when no middleware", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/about" })],
      appRoutes: [mockAppRoute({ pathname: "/api/hello" })],
      prerenders: [
        mockPrerender({
          pathname: "/blog/hello",
          fallback: { filePath: "/dist/blog.html", initialRevalidate: 60 } as any,
        }),
      ],
    });
    const cel = generateCelExpression({
      outputs,
      dynamicRoutes: [{ sourceRegex: "^/blog/([^/]+?)(?:/)?$" }] as any,
    });
    expect(cel).toContain("request.path.startsWith('/blog/')");
    expect(cel).toContain("request.path.startsWith('/_next/image')");
    expect(cel).not.toMatch(/^!\(/);
    // The no-middleware branch is NOT method-gated — resolveRoutes is body-independent, so
    // edge dispatch for POST/etc. stays valid when there's no middleware to run.
    expect(cel).not.toContain("request.method");
  });

  it("includes a purely-static ISR pathname not covered by any dynamic route", () => {
    // A fully-static prerendered page with revalidation (e.g. `export const
    // revalidate = 60`) has no dynamicRoutes prefix to fall back on, so the
    // prerender's own pathname must be included directly.
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/pricing" })],
      prerenders: [
        mockPrerender({
          pathname: "/pricing",
          sourcePage: "/pricing",
          fallback: { filePath: "/dist/pricing.html", initialRevalidate: 60 } as any,
        }),
      ],
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toContain("request.path == '/pricing'");
    expect(cel).toContain("request.path.startsWith('/_next/image')");
    expect(cel).not.toBe("false");
    expect(cel).not.toMatch(/^!\(/);
  });

  it("escapes single quotes in public-file pathnames to avoid CEL injection", () => {
    const outputs = mockOutputs({
      staticFiles: [mockStaticFile({ pathname: "/o'brien.txt" })],
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: { matchers: [] },
      } as any,
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    // The quote must be backslash-escaped, keeping the string literal intact.
    expect(cel).toContain("request.path == '/o\\'brien.txt'");
    // No unescaped quote should prematurely close the literal.
    expect(cel).not.toContain("'/o'brien.txt'");
  });

  it("returns false when nothing needs ext_proc", () => {
    const outputs = mockOutputs({
      staticFiles: [mockStaticFile({ pathname: "/_next/static/chunk.js" })],
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toBe("false");
  });

  it("excludes _next/static even when middleware matches everything", () => {
    const outputs = mockOutputs({
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: { matchers: [{ sourceRegex: "^/.*$" }] },
      } as any,
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toContain("request.path.startsWith('/_next/static/')");
  });
});
