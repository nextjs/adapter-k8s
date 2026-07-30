// Deploy-mode 404 contract (canary.97 catch-up ③ — upstream
// test/e2e/app-dir/not-found-non-document): the deployed routing layer serves the
// PRERENDERED App Router `/_not-found` page "without invoking Next.js" (the upstream test's
// own comment). Invoking the `/_not-found` function handler instead runs base-server's new
// `isNonHtmlSecFetchDest` branch, which answers `text/plain` for subresource requests
// (sec-fetch-dest: image/font/manifest) — `next start` semantics, but the deploy branch of
// the suite asserts `text/html` from the prerender. Serving the prerender is also strictly
// cheaper (no render) and byte-identical for the HTML-capable request classes.
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../../src/pool-server/dispatch.js";
import type { IncomingMessage, ServerResponse } from "node:http";

type NodeHandler = (req: IncomingMessage, res: ServerResponse, ctx: any) => unknown;

function mockReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    url,
    method: "GET",
    headers: { host: "app.example.com", ...headers },
    pipe: vi.fn(),
  } as unknown as IncomingMessage;
}

function mockRes() {
  const res = {
    _status: 200,
    _headers: {} as Record<string, string | string[]>,
    _body: "",
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    setHeader(key: string, value: string) {
      res._headers[key] = value;
      return res;
    },
    write(chunk: Buffer | string) {
      res._body += chunk.toString();
      return true;
    },
    end(body?: Buffer | string) {
      if (body) res._body += body.toString();
    },
    headersSent: false,
    writableEnded: false,
    destroyed: false,
  };
  return res as unknown as ServerResponse & typeof res;
}

let tmpDir: string;
let notFoundHtml: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "nf-prerender-"));
  notFoundHtml = path.join(tmpDir, "_not-found.html");
  writeFileSync(notFoundHtml, "<html><body><h1>custom not found page</h1></body></html>");
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeDispatcher(seen: string[], staticAssets: unknown[]) {
  // A /_not-found entrypoint that behaves like base-server at canary.97: text/plain for
  // non-HTML sec-fetch-dest. If dispatch invokes it for these requests, the deploy contract
  // breaks — the test records the invocation.
  const notFoundHandler: NodeHandler = (_req, res) => {
    seen.push("handler-invoked");
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  };
  return createDispatcher({
    handlerLoader: {
      load: vi.fn().mockResolvedValue(notFoundHandler),
      has: vi.fn((p: string) => p === "/_not-found"),
      get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "APP_PAGE", filePath: "x.js" }),
    } as any,
    poolName: "ssr",
    buildId: "test123",
    staticAssets: staticAssets as any,
  });
}

describe("deploy-mode 404: prerendered /_not-found preferred over handler invocation", () => {
  it("serves the prerendered /_not-found HTML for a subresource request without invoking the handler", async () => {
    const seen: string[] = [];
    const dispatcher = makeDispatcher(seen, [
      { pathname: "/_not-found", filePath: notFoundHtml, prerender: true },
    ]);
    const res = mockRes();
    await dispatcher.dispatch(
      mockReq("/web-app-manifest-192x192.png", { "sec-fetch-dest": "image" }),
      res,
      { kind: "not-found" } as any,
    );
    expect(res._status).toBe(404);
    expect(String(res._headers["content-type"])).toContain("text/html");
    expect(res._body).toContain("custom not found page");
    expect(seen).toEqual([]);
  });

  it("still invokes the /_not-found handler when no prerender exists", async () => {
    const seen: string[] = [];
    const dispatcher = makeDispatcher(seen, []);
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/missing-font"), res, { kind: "not-found" } as any);
    expect(seen).toEqual(["handler-invoked"]);
    expect(res._status).toBe(404);
  });
});

describe("deploy-mode 404: .next/server/app/_not-found.html disk fallback", () => {
  // The build's injected /_not-found has no source file, so the adapter OUTPUTS carry no
  // fallback.filePath and no static-asset entry is emitted — but the artifact itself is
  // always at .next/server/app/_not-found.html in the staged app. Serve it from disk.
  it("serves the on-disk prerender when no static-asset entry exists, without invoking the handler", async () => {
    const stage = mkdtempSync(path.join(os.tmpdir(), "nf-disk-"));
    const appDir = path.join(stage, ".next", "server", "app");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      path.join(appDir, "_not-found.html"),
      "<html><body>disk not found page</body></html>",
    );
    const prevCwd = process.cwd();
    process.chdir(stage);
    try {
      const seen: string[] = [];
      const dispatcher = makeDispatcher(seen, []);
      const res = mockRes();
      await dispatcher.dispatch(mockReq("/missing-font", { "sec-fetch-dest": "font" }), res, {
        kind: "not-found",
      } as any);
      expect(res._status).toBe(404);
      expect(String(res._headers["content-type"])).toContain("text/html");
      expect(res._body).toContain("disk not found page");
      expect(seen).toEqual([]);
    } finally {
      process.chdir(prevCwd);
      rmSync(stage, { recursive: true, force: true });
    }
  });
});
