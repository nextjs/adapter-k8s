// tests/pool-server/ws-upgrade.test.ts
import { describe, it, expect, vi } from "vitest";
import { handleWebSocketUpgrade } from "../../src/pool-server/ws-upgrade.js";
import { resolveUpgradeHandlerExport } from "../../src/pool-server/handler-loader.js";
import { INTERNAL_DISPATCH_HEADERS } from "../../src/routing-common.js";

function fakeSocket() {
  const chunks: Buffer[] = [];
  return {
    destroyed: false,
    write(d: string | Buffer) {
      chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
      return true;
    },
    destroy() {
      this.destroyed = true;
    },
    get data(): string {
      return Buffer.concat(chunks).toString();
    },
  };
}

function fakeReq(url: string, headers: Record<string, string | string[]> = {}) {
  return { url, method: "GET", headers: { host: "example.com", ...headers } };
}

const HEAD = Buffer.from([]);
const routeRes = (over: Record<string, unknown> = {}) => ({
  kind: "route",
  pool: "default",
  matchedPathname: "/api/ws/[id]",
  routeMatches: { id: "abc" },
  ...over,
});
const baseDeps = (over: Record<string, unknown> = {}) =>
  ({
    resolve: vi.fn(async () => routeRes()),
    loadUpgrade: vi.fn(async () => undefined),
    hasOutput: () => true,
    makeEmptyBody: () => null,
    minimalMode: true,
    poolName: "default",
    releaseName: "app",
    buildId: "b1",
    ...over,
  }) as any;

describe("resolveUpgradeHandlerExport (feature-detection)", () => {
  const fn = () => {};
  it("finds a top-level upgradeHandler export", () => {
    expect(resolveUpgradeHandlerExport({ upgradeHandler: fn } as any)).toBe(fn);
  });
  it("finds upgradeHandler on the default export object", () => {
    expect(resolveUpgradeHandlerExport({ default: { upgradeHandler: fn } } as any)).toBe(fn);
  });
  it("finds upgradeHandler on routeModule (Turbopack shape)", () => {
    expect(resolveUpgradeHandlerExport({ routeModule: { upgradeHandler: fn } } as any)).toBe(fn);
  });
  it("finds upgradeHandler in routeModule.userland under the default export (compiled App Route)", () => {
    // Real canary.88 shape: mod.default.routeModule.userland.upgradeHandler
    expect(
      resolveUpgradeHandlerExport({ default: { routeModule: { userland: { upgradeHandler: fn } } } } as any),
    ).toBe(fn);
  });
  it("survives a throwing userland getter (graceful → undefined)", () => {
    const mod = { default: { routeModule: {} } } as any;
    Object.defineProperty(mod.default.routeModule, "userland", {
      get() {
        throw new Error("userland not ready");
      },
    });
    expect(resolveUpgradeHandlerExport(mod)).toBeUndefined();
  });
  it("returns undefined for a plain HTTP route (no WS) — graceful degrade", () => {
    expect(resolveUpgradeHandlerExport({ handler: fn } as any)).toBeUndefined();
    expect(resolveUpgradeHandlerExport({} as any)).toBeUndefined();
  });
});

describe("handleWebSocketUpgrade", () => {
  it("dispatches to upgradeHandler with the Next contract when the route has one", async () => {
    const upgradeHandler = vi.fn();
    const deps = baseDeps({ loadUpgrade: vi.fn(async () => upgradeHandler) });
    const socket = fakeSocket();
    const req = fakeReq("/api/ws/abc");

    await handleWebSocketUpgrade(deps, req as any, socket as any, HEAD);

    expect(upgradeHandler).toHaveBeenCalledOnce();
    const [ctx, second] = upgradeHandler.mock.calls[0];
    // second arg is Next's `{ node: { req, socket, head } }`
    expect(second).toEqual({ node: { req, socket, head: HEAD } });
    // context mirrors the HTTP handler's shape
    expect(typeof ctx.waitUntil).toBe("function");
    expect(ctx.requestMeta.matchedPathname).toBe("/api/ws/[id]");
    expect(ctx.requestMeta.outputId).toBe("/api/ws/[id]");
    expect(ctx.requestMeta.params).toEqual({ id: "abc" });
    expect(ctx.requestMeta.minimalMode).toBe(true);
    expect(ctx.requestMeta.initURL).toBe("http://example.com/api/ws/abc");
    expect(ctx.requestMeta.hostname).toBe("example.com");
    // the handler owns the socket now — we must not have closed it
    expect(socket.destroyed).toBe(false);
  });

  it("applies middleware request-header mutations before invoking (deletion is authoritative)", async () => {
    const upgradeHandler = vi.fn();
    const mw = new Headers();
    mw.set("x-injected", "by-mw");
    // The client sent x-spoofed; middleware's set omits it → it must NOT reach the route.
    const deps = baseDeps({
      loadUpgrade: vi.fn(async () => upgradeHandler),
      resolve: vi.fn(async () => routeRes({ middlewareRequestHeaders: mw })),
    });
    const req = fakeReq("/api/ws/abc", { "x-spoofed": "evil" });
    await handleWebSocketUpgrade(deps, req as any, fakeSocket() as any, HEAD);
    expect(req.headers["x-injected"]).toBe("by-mw");
    expect(req.headers["x-spoofed"]).toBeUndefined();
  });

  it("applies rewrites to the raw request URL and the handler context", async () => {
    const upgradeHandler = vi.fn();
    const deps = baseDeps({
      loadUpgrade: vi.fn(async () => upgradeHandler),
      resolve: vi.fn(async () =>
        routeRes({ invokePath: "/api/ws/abc?x=1", invocationQuery: { x: "1" } }),
      ),
    });
    const req = fakeReq("/pretty/abc");
    await handleWebSocketUpgrade(deps, req as any, fakeSocket() as any, HEAD);
    expect(req.url).toBe("/api/ws/abc?x=1"); // raw request URL synced to the rewrite
    const [ctx] = upgradeHandler.mock.calls[0];
    expect(ctx.requestMeta.rewrittenPathname).toBe("/api/ws/abc");
    expect(ctx.requestMeta.query).toEqual({ x: "1" });
    expect(ctx.requestMeta.initURL).toBe("http://example.com/pretty/abc"); // original preserved
  });

  it("forwards to the owning pool on a wrong-pool landing (no local 426, no local dispatch)", async () => {
    const loadUpgrade = vi.fn(async () => undefined);
    const deps = baseDeps({
      poolName: "default",
      hasOutput: () => false, // this pool does not own the resolved output
      loadUpgrade,
      resolve: vi.fn(async () => routeRes({ pool: "api" })), // route belongs to pool "api"
    });
    const socket = fakeSocket();
    await handleWebSocketUpgrade(deps, fakeReq("/api/ws/abc") as any, socket as any, HEAD);
    // Took the cross-pool proxy branch, not local dispatch/426: the handler was never loaded and no
    // 426 was written here. (The proxy fires an async request to the sibling pool; its piping and
    // its 502-on-unreachable-sibling behavior are covered by the live e2e, not this unit test.)
    expect(loadUpgrade).not.toHaveBeenCalled();
    expect(socket.data).not.toContain("426");
  });

  it("answers 426 when the route has no upgradeHandler (older Next / plain route)", async () => {
    const deps = baseDeps({ loadUpgrade: vi.fn(async () => undefined) });
    const socket = fakeSocket();
    await handleWebSocketUpgrade(deps, fakeReq("/api/ws/abc") as any, socket as any, HEAD);
    expect(socket.data).toContain("426 Upgrade Required");
    expect(socket.destroyed).toBe(true);
  });

  it("answers 404 for a not-found resolution", async () => {
    const deps = baseDeps({ resolve: vi.fn(async () => ({ kind: "not-found" })) });
    const socket = fakeSocket();
    await handleWebSocketUpgrade(deps, fakeReq("/nope") as any, socket as any, HEAD);
    expect(socket.data).toContain("404");
    expect(socket.destroyed).toBe(true);
  });

  it("relays a middleware redirect (auth) instead of upgrading", async () => {
    const deps = baseDeps({
      resolve: vi.fn(async () => ({
        kind: "redirect",
        url: new URL("https://example.com/login"),
        status: 307,
      })),
    });
    const socket = fakeSocket();
    await handleWebSocketUpgrade(deps, fakeReq("/api/ws/abc") as any, socket as any, HEAD);
    expect(socket.data).toContain("307");
    expect(socket.data.toLowerCase()).toContain("location: https://example.com/login");
    expect(socket.destroyed).toBe(true);
  });

  it("relays a middleware short-circuit response (401 body)", async () => {
    const deps = baseDeps({
      resolve: vi.fn(async () => ({
        kind: "middleware-response",
        response: new Response("denied", { status: 401 }),
      })),
    });
    const socket = fakeSocket();
    await handleWebSocketUpgrade(deps, fakeReq("/api/ws/abc") as any, socket as any, HEAD);
    expect(socket.data).toContain("401");
    expect(socket.data).toContain("denied");
    expect(socket.destroyed).toBe(true);
  });

  it("answers 500 (not crash) when resolution throws", async () => {
    const deps = baseDeps({
      resolve: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const socket = fakeSocket();
    await handleWebSocketUpgrade(deps, fakeReq("/api/ws/abc") as any, socket as any, HEAD);
    expect(socket.data).toContain("500");
    expect(socket.destroyed).toBe(true);
  });

  it("strips spoofable internal dispatch headers before resolving", async () => {
    let seen: Headers | undefined;
    const dispatchHeader = INTERNAL_DISPATCH_HEADERS[0]!;
    const deps = baseDeps({
      resolve: vi.fn(async (_url: URL, headers: Headers) => {
        seen = headers;
        return { kind: "not-found" };
      }),
    });
    const req = fakeReq("/api/ws/abc", { [dispatchHeader]: "/evil", "x-internal-secret": "spoof" });
    await handleWebSocketUpgrade(deps, req as any, fakeSocket() as any, HEAD);
    expect(seen!.get(dispatchHeader)).toBeNull();
    expect(req.headers[dispatchHeader]).toBeUndefined();
  });
});
