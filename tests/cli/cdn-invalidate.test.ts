// tests/cli/cdn-invalidate.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCdnUrlMap, invalidateCdnBuildTag, type Runner } from "../../src/cli/cdn-invalidate.js";
import { cdnTagForBuildId } from "../../src/cdn-tags.js";

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr = "boom") => ({ exitCode: 1, stdout: "", stderr });

/** A Runner driven by a route table keyed on a substring of the joined args. */
function fakeRunner(routes: Array<[string, ReturnType<typeof ok>]>): {
  run: Runner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: Runner = async (_cmd, args) => {
    calls.push(args);
    const j = args.join(" ");
    for (const [needle, res] of routes) if (j.includes(needle)) return res;
    return fail("unexpected: " + j);
  };
  return { run, calls };
}

describe("resolveCdnUrlMap", () => {
  it("resolves the url-map from the release IP via forwarding rule + https proxy", async () => {
    const { run } = fakeRunner([
      ["addresses describe", ok("34.1.2.3")],
      ["forwarding-rules list", ok("https://www.googleapis.com/x/targetHttpsProxies/rel-proxy")],
      ["target-https-proxies describe", ok("https://www.googleapis.com/x/urlMaps/rel-urlmap")],
    ]);
    expect(await resolveCdnUrlMap("proj", "rel", run)).toBe("rel-urlmap");
  });

  it("returns null when the address describe fails", async () => {
    const { run } = fakeRunner([["addresses describe", fail()]]);
    expect(await resolveCdnUrlMap("proj", "rel", run)).toBeNull();
  });

  it("returns null when forwarding-rules list fails", async () => {
    const { run } = fakeRunner([
      ["addresses describe", ok("34.1.2.3")],
      ["forwarding-rules list", fail()],
    ]);
    expect(await resolveCdnUrlMap("proj", "rel", run)).toBeNull();
  });

  it("returns null (not a wrong guess) for an unknown target type", async () => {
    const { run, calls } = fakeRunner([
      ["addresses describe", ok("34.1.2.3")],
      ["forwarding-rules list", ok("https://www.googleapis.com/x/targetGrpcProxies/rel-proxy")],
    ]);
    expect(await resolveCdnUrlMap("proj", "rel", run)).toBeNull();
    // never attempted a describe on the unknown target
    expect(calls.some((c) => c.join(" ").includes("describe") && c.join(" ").includes("rel-proxy"))).toBe(false);
  });

  it("returns null when the proxy describe fails to yield a url-map", async () => {
    const { run } = fakeRunner([
      ["addresses describe", ok("34.1.2.3")],
      ["forwarding-rules list", ok(".../targetHttpProxies/rel-proxy")],
      ["target-http-proxies describe", fail()],
    ]);
    expect(await resolveCdnUrlMap("proj", "rel", run)).toBeNull();
  });
});

describe("invalidateCdnBuildTag", () => {
  let dir: string;
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const happyRoutes: Array<[string, ReturnType<typeof ok>]> = [
    ["addresses describe", ok("34.1.2.3")],
    ["forwarding-rules list", ok(".../targetHttpsProxies/p")],
    ["target-https-proxies describe", ok(".../urlMaps/um")],
    ["invalidate-cdn-cache", ok("Completed invalidation")],
  ];

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `cdn-inv-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    logs.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const invalidateCall = (calls: string[][]) =>
    calls.find((c) => c.includes("invalidate-cdn-cache"));

  it("invalidates the safe hashed tag, synchronously (no --async)", async () => {
    writeFileSync(path.join(dir, "cdn-invalidation.json"), JSON.stringify({ invalidateOnDeploy: true }));
    const { run, calls } = fakeRunner(happyRoutes);
    await invalidateCdnBuildTag({ projectId: "proj", releaseName: "rel", outputDir: dir, buildId: "old42", run, log });
    const call = invalidateCall(calls)!;
    expect(call).toContain(`--tags=${cdnTagForBuildId("old42")}`);
    expect(call).not.toContain("--async");
    expect(call).toContain("um");
  });

  it("skips when there is no outgoing build id", async () => {
    const { run, calls } = fakeRunner(happyRoutes);
    await invalidateCdnBuildTag({ projectId: "proj", releaseName: "rel", outputDir: dir, buildId: undefined, run, log });
    expect(invalidateCall(calls)).toBeUndefined();
  });

  it("skips when the sidecar opts out (invalidateOnDeploy:false)", async () => {
    writeFileSync(path.join(dir, "cdn-invalidation.json"), JSON.stringify({ invalidateOnDeploy: false }));
    const { run, calls } = fakeRunner(happyRoutes);
    await invalidateCdnBuildTag({ projectId: "proj", releaseName: "rel", outputDir: dir, buildId: "old42", run, log });
    expect(invalidateCall(calls)).toBeUndefined();
  });

  it("DEFAULTS ON when the sidecar is missing", async () => {
    const { run, calls } = fakeRunner(happyRoutes); // no sidecar written
    await invalidateCdnBuildTag({ projectId: "proj", releaseName: "rel", outputDir: dir, buildId: "old42", run, log });
    expect(invalidateCall(calls)).toBeDefined();
  });

  it("DEFAULTS ON when the sidecar is malformed", async () => {
    writeFileSync(path.join(dir, "cdn-invalidation.json"), "{not json");
    const { run, calls } = fakeRunner(happyRoutes);
    await invalidateCdnBuildTag({ projectId: "proj", releaseName: "rel", outputDir: dir, buildId: "old42", run, log });
    expect(invalidateCall(calls)).toBeDefined();
  });

  it("skips + warns when the url-map cannot be resolved", async () => {
    const { run, calls } = fakeRunner([["addresses describe", fail()]]);
    await invalidateCdnBuildTag({ projectId: "proj", releaseName: "rel", outputDir: dir, buildId: "old42", run, log });
    expect(invalidateCall(calls)).toBeUndefined();
    expect(logs.some((l) => /could not resolve url-map/.test(l))).toBe(true);
  });

  it("does not throw when the invalidation command fails (non-fatal)", async () => {
    const { run } = fakeRunner([
      ["addresses describe", ok("34.1.2.3")],
      ["forwarding-rules list", ok(".../targetHttpsProxies/p")],
      ["target-https-proxies describe", ok(".../urlMaps/um")],
      ["invalidate-cdn-cache", fail("quota")],
    ]);
    await expect(
      invalidateCdnBuildTag({ projectId: "proj", releaseName: "rel", outputDir: dir, buildId: "old42", run, log }),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => /invalidation failed/.test(l))).toBe(true);
  });
});
