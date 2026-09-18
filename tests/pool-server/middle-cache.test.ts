import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPoolServer } from "../../src/pool-server/server.js";
import { createDispatcher } from "../../src/pool-server/dispatch.js";
import {
  handOffStaticAsset,
  MIDDLE_CACHE_ASSET_HEADER,
} from "../../src/pool-server/middle-cache.js";

let server: ReturnType<typeof createPoolServer> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.unstubAllEnvs();
});

describe("middle cache trust boundary", () => {
  it("hands off the resolved file with fresh middleware headers and no Node body", async () => {
    vi.stubEnv("ADAPTER_K8S_MIDDLE_CACHE", "1");
    const dir = mkdtempSync(path.join(os.tmpdir(), "middle-cache-"));
    const file = path.join(dir, "private.txt");
    writeFileSync(file, "asset bytes");
    const asset = { pathname: "/private.txt", filePath: file, cacheControl: "no-cache" };
    const dispatcher = createDispatcher({
      poolName: "ssr",
      buildId: "build123",
      staticAssets: [asset],
      handlerLoader: { has: () => false, get: () => undefined } as never,
      localHandlerInvoker: vi.fn(),
    });
    server = createPoolServer({
      port: 0,
      onRequest: async (req, res) => {
        expect(req.headers["x-adapter-middle-cache"]).toBeUndefined();
        await dispatcher.dispatch(req, res, {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/private.txt",
          routeMatches: null,
          resolvedHeaders: new Headers([
            ["x-request-user", "alice"],
            ["set-cookie", "one=1"],
            ["set-cookie", "two=2"],
            [MIDDLE_CACHE_ASSET_HEADER, "forged"],
            ["content-length", "999"],
          ]),
        });
      },
    });
    try {
      const { port } = await server.start();
      const response = await fetch(`http://127.0.0.1:${port}/rewrite`, {
        headers: { "x-adapter-middle-cache": "1" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get(MIDDLE_CACHE_ASSET_HEADER)).toBe(
        createHash("sha256").update(file).digest("hex"),
      );
      expect(response.headers.get("content-length")).toBe("0");
      expect(response.headers.get("x-request-user")).toBe("alice");
      expect(response.headers.getSetCookie()).toEqual(["one=1", "two=2"]);
      expect(await response.text()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["object", "flat", "setHeader"])(
    "strips forged application handoffs through %s",
    async (shape) => {
      vi.stubEnv("ADAPTER_K8S_MIDDLE_CACHE", "1");
      server = createPoolServer({
        port: 0,
        onRequest: (_req, res) => {
          if (shape === "object") res.writeHead(200, { "X-Adapter-Asset": "forged" });
          else if (shape === "flat") res.writeHead(200, ["X-Adapter-Asset", "forged"]);
          else {
            res.setHeader("X-Adapter-Asset", "forged");
            res.writeHead(200);
          }
          res.end("dynamic response");
        },
      });
      const { port } = await server.start();
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { "x-adapter-middle-cache": "1" },
      });
      expect(response.headers.get(MIDDLE_CACHE_ASSET_HEADER)).toBeNull();
      expect(await response.text()).toBe("dynamic response");
    },
  );

  it.each([
    { enabled: "", method: "GET", prerender: false, capability: "1" },
    { enabled: "1", method: "GET", prerender: false, capability: "" },
    { enabled: "1", method: "POST", prerender: false, capability: "1" },
    { enabled: "1", method: "GET", prerender: true, capability: "1" },
  ])(
    "keeps noneligible requests on Node: %j",
    async ({ enabled, method, prerender, capability }) => {
      vi.stubEnv("ADAPTER_K8S_MIDDLE_CACHE", enabled);
      server = createPoolServer({
        port: 0,
        onRequest: (req, res) => {
          expect(
            handOffStaticAsset(
              req,
              res,
              { pathname: "/asset", filePath: "public/asset", cacheControl: "no-cache", prerender },
              {},
            ),
          ).toBe(false);
          res.end("Node response");
        },
      });
      const { port } = await server.start();
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method,
        headers: { "x-adapter-middle-cache": capability },
      });
      expect(response.headers.get(MIDDLE_CACHE_ASSET_HEADER)).toBeNull();
      expect(await response.text()).toBe("Node response");
    },
  );
});
