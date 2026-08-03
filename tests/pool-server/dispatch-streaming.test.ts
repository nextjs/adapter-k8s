// tests/pool-server/dispatch-streaming.test.ts
// Real-socket tests for the dispatch response boundary: when headers reach the client, what
// happens to a handler that never answers, and the internal-header leak guards on the
// entrypoint response. These need the REAL loopback invoker (invokeLocalHandlerOverHttp is
// module-private), so every case drives createDispatcher over an actual HTTP server, in the
// style of tests/pool-server/server.test.ts.
import { describe, it, expect, afterEach } from "vitest";
import { createServer, get as httpGet, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createDispatcher } from "../../src/pool-server/dispatch.js";
import { STATIC_STREAM_THRESHOLD_BYTES } from "../../src/pool-server/http-cache.js";
import type { ResolveResult } from "../../src/pool-server/resolve.js";

type NodeHandler = (req: IncomingMessage, res: import("node:http").ServerResponse) => void;

function handlerLoaderFor(outputId: string, handler: NodeHandler, type = "APP_ROUTE") {
  return {
    has: (id: string) => id === outputId,
    load: async () => handler,
    get: () => ({ id: outputId, pathname: outputId, filePath: "unused", type, runtime: "nodejs" }),
  } as any;
}

/** A pool-shaped front server: every request is handed straight to dispatcher.dispatch. */
async function startFront(
  dispatcherOptions: Parameters<typeof createDispatcher>[0],
  resolution: ResolveResult,
): Promise<{ port: number; server: Server }> {
  const dispatcher = createDispatcher(dispatcherOptions);
  const server = createServer((req, res) => {
    void dispatcher.dispatch(req, res, resolution).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, server };
}

/** Timings and headers as the CLIENT observes them: when did the head arrive vs the first byte. */
function timedGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
  headersAtMs: number;
  firstByteAtMs: number;
  endAtMs: number;
}> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: "127.0.0.1", port, path, headers }, (res) => {
      const headersAtMs = Date.now() - start;
      let firstByteAtMs = -1;
      let body = "";
      res.on("data", (chunk) => {
        if (firstByteAtMs < 0) firstByteAtMs = Date.now() - start;
        body += String(chunk);
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          headersAtMs,
          firstByteAtMs,
          endAtMs: Date.now() - start,
        }),
      );
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("client timeout")));
  });
}

const routeResolution = (matchedPathname: string): ResolveResult => ({
  kind: "route",
  pool: "main",
  matchedPathname,
  routeMatches: null,
  resolvedHeaders: undefined,
});

let openServers: Server[] = [];
afterEach(async () => {
  await Promise.all(openServers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  openServers = [];
});

// S41 (AVAILABILITY): manifest-backed assets bypassed the size-aware static serving path and
// synchronously buffered the complete body before even checking If-None-Match.
describe("manifest-backed static asset bounds", () => {
  it("streams a large body and answers a conditional request without a body", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "manifest-static-stream-"));
    const filePath = path.join(dir, "large.bin");
    const body = Buffer.alloc(STATIC_STREAM_THRESHOLD_BYTES + 1, 0x61);
    writeFileSync(filePath, body);
    try {
      const front = await startFront(
        {
          handlerLoader: handlerLoaderFor("/unused", () => undefined),
          poolName: "main",
          buildId: "b1",
          staticAssets: [
            {
              pathname: "/large.bin",
              filePath,
              cacheControl: "public, max-age=0, must-revalidate",
            },
          ],
        },
        routeResolution("/large.bin"),
      );
      openServers.push(front.server);

      const first = await timedGet(front.port, "/large.bin");
      expect(first.status).toBe(200);
      expect(first.headers["content-length"]).toBe(String(body.length));
      expect(first.body.length).toBe(body.length);
      expect(first.headers.etag).toMatch(/^".+"$/);

      const conditional = await timedGet(front.port, "/large.bin", {
        "if-none-match": String(first.headers.etag),
      });
      expect(conditional.status).toBe(304);
      expect(conditional.body).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// N36: writeInnerResponse awaited `iterator.next()` — the handler's FIRST BODY CHUNK — before
// `outerRes.writeHead(...)`, unconditionally. The peek exists for exactly one reason: deciding
// whether a build-time PPR shell may be prepended (a handler that replays its own prelude must
// not get a second document concatenated in front of it). With no shell to prepend there is
// nothing to decide, and the wait turned every header-first stream into a stall: measured 1213 ms
// to headers for a handler that flushes at 0 ms and writes at 1200 ms, where `next start` sends
// the head at +14 ms (measured, Next 16.2.10, `res.flushHeaders()` + a 1200 ms delayed write) so
// an EventSource opens immediately.
describe("streamed responses commit headers before the first body byte", () => {
  const WRITE_DELAY_MS = 800;

  it("sends the head immediately for a handler that flushes then writes late", async () => {
    const front = await startFront(
      {
        handlerLoader: handlerLoaderFor("/sse", (_req, res) => {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          res.flushHeaders();
          setTimeout(() => {
            res.write("data: one\n\n");
            res.end();
          }, WRITE_DELAY_MS);
        }),
        poolName: "main",
        buildId: "b1",
        staticAssets: [],
      },
      routeResolution("/sse"),
    );
    openServers.push(front.server);

    const res = await timedGet(front.port, "/sse");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body).toBe("data: one\n\n");
    // The head must NOT wait for the body. Half the write delay is a generous bound: before the
    // fix headersAtMs tracked firstByteAtMs exactly.
    expect(res.headersAtMs).toBeLessThan(WRITE_DELAY_MS / 2);
    expect(res.firstByteAtMs).toBeGreaterThanOrEqual(WRITE_DELAY_MS - 100);
  });

  it("still prepends a PPR shell without duplicating a handler-rendered document", async () => {
    // The peek is retained for the shell case — this is the behavior it exists for, and it must
    // keep working: a handler whose first bytes are a full HTML document already replayed its
    // prelude, so the shell must be DROPPED rather than concatenated.
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "ppr-prefix-"));
    writeFileSync(path.join(dir, "shell.html"), "<!doctype html><html><body>SHELL");

    const front = await startFront(
      {
        handlerLoader: handlerLoaderFor(
          "/doc",
          (_req, res) => {
            res.writeHead(200, { "content-type": "text/html" });
            res.end("<!doctype html><html><body>WHOLE DOCUMENT");
          },
          "APP_PAGE",
        ),
        poolName: "main",
        buildId: "b1",
        staticAssets: [],
        pprRoutes: {
          "/doc": { postponedState: "state", fallbackFilePath: path.join(dir, "shell.html") },
        },
      },
      routeResolution("/doc"),
    );
    openServers.push(front.server);

    const res = await timedGet(front.port, "/doc");
    expect(res.status).toBe(200);
    expect(res.body).toBe("<!doctype html><html><body>WHOLE DOCUMENT");
  });
});

// N37: `createServer` + `listen(0)` per invocation, with the only bounded waits being
// proxyTimeoutMs (cross-pool/external only) and the server-wide requestTimeout, which measures
// request RECEIPT rather than handler runtime. A wedged handler therefore held a listening
// socket, an ephemeral port, its pendingWaitUntil set and the client socket indefinitely.
describe("handler invocation deadline", () => {
  it("504s a handler that never answers, instead of pinning the request forever", async () => {
    const front = await startFront(
      {
        handlerLoader: handlerLoaderFor("/wedged", () => {
          // Never writes, never ends.
        }),
        poolName: "main",
        buildId: "b1",
        staticAssets: [],
        handlerTimeoutMs: 300,
      },
      routeResolution("/wedged"),
    );
    openServers.push(front.server);

    const res = await timedGet(front.port, "/wedged");
    expect(res.status).toBe(504);
    expect(res.endAtMs).toBeLessThan(5_000);
  });

  it("does not cut off a slow but PROGRESSING stream once the head is committed", async () => {
    // The deadline bounds time-to-response-head, not stream duration — the same discipline the
    // cross-pool proxy already applies (it disarms its idle timeout once headers arrive).
    // Bounding the whole stream would kill SSE and long PPR resumes, which same-pool routes
    // serve with no such cap.
    const front = await startFront(
      {
        handlerLoader: handlerLoaderFor("/slow-stream", (_req, res) => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.flushHeaders();
          let written = 0;
          const timer = setInterval(() => {
            res.write("chunk\n");
            if (++written === 4) {
              clearInterval(timer);
              res.end();
            }
          }, 150);
        }),
        poolName: "main",
        buildId: "b1",
        staticAssets: [],
        handlerTimeoutMs: 300,
      },
      routeResolution("/slow-stream"),
    );
    openServers.push(front.server);

    const res = await timedGet(front.port, "/slow-stream");
    expect(res.status).toBe(200);
    expect(res.body).toBe("chunk\nchunk\nchunk\nchunk\n");
    expect(res.endAtMs).toBeGreaterThan(300);
  });
});

// N30 (SECURITY/CACHE), leak-guard half: writeInnerResponse rewrites an origin-oriented
// cache-control only when it sees `x-nextjs-cache` or `x-nextjs-prerender`. A POSTPONED response
// carries `x-nextjs-postponed` and need carry neither of those, so the year-long `s-maxage`
// on an unfinished PPR shell passed through untouched — untagged, therefore unpurgeable at
// cutover. `next start` answers a PPR document `private, no-cache, no-store, max-age=0,
// must-revalidate` (measured).
describe("postponed responses never keep a CDN-storable cache-control", () => {
  it("rewrites s-maxage and drops the cache-tag when x-nextjs-postponed is present", async () => {
    const front = await startFront(
      {
        handlerLoader: handlerLoaderFor(
          "/ppr",
          (_req, res) => {
            res.writeHead(200, {
              "content-type": "text/html",
              "cache-control": "s-maxage=31536000",
              "cache-tag": "build-deadbeef",
              "x-nextjs-postponed": "1",
            });
            res.end("<p>shell</p>");
          },
          "APP_PAGE",
        ),
        poolName: "main",
        buildId: "b1",
        staticAssets: [],
      },
      routeResolution("/ppr"),
    );
    openServers.push(front.server);

    const res = await timedGet(front.port, "/ppr");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
    expect(res.headers["cache-tag"]).toBeUndefined();
  });

  it("does NOT weaken a postponed response the entrypoint already declared uncacheable", async () => {
    // Same rule as the x-nextjs-prerender guard: this exists to stop long-lived leaks, never to
    // loosen a stricter verdict.
    const front = await startFront(
      {
        handlerLoader: handlerLoaderFor(
          "/ppr-strict",
          (_req, res) => {
            res.writeHead(200, {
              "content-type": "text/html",
              "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate",
              "x-nextjs-postponed": "1",
            });
            res.end("<p>shell</p>");
          },
          "APP_PAGE",
        ),
        poolName: "main",
        buildId: "b1",
        staticAssets: [],
      },
      routeResolution("/ppr-strict"),
    );
    openServers.push(front.server);

    const res = await timedGet(front.port, "/ppr-strict");
    expect(res.headers["cache-control"]).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });
});
