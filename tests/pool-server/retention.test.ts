import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRetentionReader, signRetention, type RetainedBuild } from "../../src/retention.js";
import { proxyRetainedBuild } from "../../src/pool-server/retention.js";

const action = "a".repeat(40);
const servers: Server[] = [];
const dirs: string[] = [];
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(mode: "valid" | "expired" | "tampered" = "valid", reset = false) {
  let invocations = 0;
  let body = "";
  let headers: Record<string, unknown> = {};
  const old = await listen(
    createServer(async (req, res) => {
      headers = req.headers;
      // This models the old build's full middleware door, not a trusted handler hop.
      if (req.headers.cookie !== "auth=yes") {
        res.writeHead(403);
        res.end("denied");
        return;
      }
      for await (const chunk of req) body += chunk;
      invocations++;
      if (reset) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, {
        "set-cookie": ["first=1", "second=2"],
        "cache-control": "public, max-age=3600",
      });
      res.write("old:");
      res.end(body || "asset");
    }),
  );
  const common = {
    defaultPool: "default",
    pools: ["default"],
    gracePeriodSeconds: 300,
    assets: [],
    actions: [],
    origin: old,
    expiresAt: Date.now() + 30_000,
  };
  const builds: RetainedBuild[] = [
    { ...common, buildId: "new", deploymentId: "new" },
    {
      ...common,
      buildId: "old",
      deploymentId: "old",
      assets: ["/_next/static/immutable/chunks/old.js"],
      actions: [action],
      expiresAt: mode === "expired" ? Date.now() - 1 : common.expiresAt,
    },
  ];
  const root = await mkdtemp(path.join(tmpdir(), "retention-test-"));
  dirs.push(root);
  const file = path.join(root, "index.json");
  const signed = signRetention(builds, "test-secret");
  if (mode === "tampered")
    signed.payload = signed.payload.replace('"buildId":"old"', '"buildId":"evil"');
  await writeFile(file, JSON.stringify({ new: signed }));
  const read = createRetentionReader({ file, secret: "test-secret", buildId: "new" });
  const origin = await listen(
    createServer(async (req, res) => {
      const selected = await read(
        new URL(req.url!, "http://local"),
        req.method!,
        req.headers["x-deployment-id"] as string,
        req.headers["next-action"] as string,
      );
      if (selected) await proxyRetainedBuild(req, res, selected.origin);
      else {
        res.writeHead(404);
        res.end("current build miss");
      }
    }),
  );
  return { origin, facts: () => ({ invocations, body, headers }) };
}

describe("retained build HTTP boundary", () => {
  it("coalesces concurrent index reads without dropping eligible requests", async () => {
    const { origin, facts } = await fixture();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        fetch(origin + "/_next/static/immutable/chunks/old.js", {
          headers: { cookie: "auth=yes" },
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(200));
    await Promise.all(responses.map((response) => response.text()));
    expect(facts().invocations).toBe(20);
  });

  it("enforces the signed deadline on a previously used index", async () => {
    const { origin, facts } = await fixture();
    const response = await fetch(origin + "/_next/static/immutable/chunks/old.js", {
      headers: { cookie: "auth=yes" },
    });
    expect(response.status).toBe(200);
    await response.text();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    const expired = await fetch(origin + "/_next/static/immutable/chunks/old.js", {
      headers: { cookie: "auth=yes" },
    });
    expect(expired.status).toBe(404);
    expect(facts().invocations).toBe(1);
  });
  it("preserves old middleware denial even with forged dispatch headers", async () => {
    const { origin, facts } = await fixture();
    const response = await fetch(origin + "/_next/static/immutable/chunks/old.js", {
      headers: {
        "x-mw-evaluated": "skip-nomatch",
        "x-output-id": "/",
        "x-internal-secret": "forged",
        "x-dispatch-proof": "forged",
      },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("denied");
    expect(facts().invocations).toBe(0);
    expect(facts().headers["x-mw-evaluated"]).toBeUndefined();
    expect(facts().headers["x-internal-secret"]).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("streams the action body once and preserves separate cookies", async () => {
    const { origin, facts } = await fixture();
    const response = await fetch(origin + "/form", {
      method: "POST",
      headers: { "next-action": action, cookie: "auth=yes" },
      body: "one mutation",
    });
    expect(await response.text()).toBe("old:one mutation");
    expect(facts().invocations).toBe(1);
    expect(response.headers.getSetCookie()).toEqual(["first=1", "second=2"]);
  });
  it("does not replay a mutation after a reset", async () => {
    const { origin, facts } = await fixture("valid", true);
    const response = await fetch(origin + "/form", {
      method: "POST",
      headers: { "next-action": action, cookie: "auth=yes" },
      body: "one mutation",
    });
    expect(response.status).toBe(502);
    expect(facts().invocations).toBe(1);
  });
  it.each(["expired", "tampered"] as const)(
    "does not forward through an %s index",
    async (mode) => {
      const { origin, facts } = await fixture(mode);
      const response = await fetch(origin + "/_next/static/immutable/chunks/old.js", {
        headers: { cookie: "auth=yes" },
      });
      expect(response.status).toBe(404);
      expect(facts().invocations).toBe(0);
    },
  );
  it("does not pin ordinary navigation to an old deployment ID", async () => {
    const { origin, facts } = await fixture();
    const response = await fetch(origin + "/page", {
      headers: { "x-deployment-id": "old", cookie: "auth=yes" },
    });
    expect(response.status).toBe(404);
    expect(facts().invocations).toBe(0);
  });
});
