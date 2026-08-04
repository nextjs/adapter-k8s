// Root-page PPR shell injection: the rdc fixture's `/` (a concrete PPR prerender keyed "/"
// in pprRoutes) served LIVE values instead of the build shell on the k3d cluster — the
// injection ladder must find the "/" entry under every root spelling the router produces.
import { it, expect, vi } from "vitest";
import { createDispatcher } from "../../src/pool-server/dispatch.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "root-shell-"));
const shellFile = path.join(dir, "index.html");
writeFileSync(shellFile, "<html>build shell</html>");

function mockReq(url: string): any {
  return { url, method: "GET", headers: { host: "x.example.com" }, pipe: vi.fn() };
}
function mockRes(): any {
  return {
    headersSent: false, writableEnded: false,
    setHeader: vi.fn(), getHeaderNames: () => [], removeHeader: vi.fn(),
    writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn(), once: vi.fn(), emit: vi.fn(),
  };
}
const handlerLoader = {
  has: (p: string) => p === "/" || p === "/index",
  load: vi.fn().mockResolvedValue({}),
  get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "APP_PAGE", filePath: "x.js" }),
} as any;

for (const mp of ["/", "/index"]) {
  it(`injects for root when matchedPathname=${mp}`, async () => {
    const calls: any[] = [];
    const dispatcher = createDispatcher({
      handlerLoader,
      poolName: "ssr",
      buildId: "b1",
      staticAssets: [
        { pathname: "/", filePath: shellFile, prerender: true, ppr: true },
      ] as any,
      pprRoutes: { "/": { postponedState: "tok", fallbackFilePath: shellFile } } as any,
      incrementalCacheShared: true,
      localHandlerInvoker: (async (a: any) => { calls.push(a); }) as any,
    } as any);
    const req = mockReq("/");
    await dispatcher.dispatch(req, mockRes(), {
      kind: "route", matchedPathname: mp, pool: "ssr", routeMatches: null,
    } as any);
    expect(calls).toHaveLength(1);
    const meta = (req as any)[Symbol.for("NextInternalRequestMeta")];
    expect(meta?.postponed, `mp=${mp}`).toBe("tok");
  });
}
