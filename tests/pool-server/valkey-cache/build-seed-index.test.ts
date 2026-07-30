// Unit tests for the build-seed index (see the module header for why it exists — the
// dynamicParams:false invariant 500 measured live on GKE 2026-07-30).
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSeedSources,
  createBuildSeedLookup,
} from "../../../src/pool-server/valkey-cache/build-seed-index.js";

let appRoot: string;

const asset = (over: Record<string, unknown>) => ({
  cacheControl: "public, max-age=0, must-revalidate",
  prerender: true,
  ...over,
});

beforeEach(() => {
  appRoot = mkdtempSync(path.join(os.tmpdir(), "seed-index-"));
});
afterEach(() => {
  rmSync(appRoot, { recursive: true, force: true });
});

function stage(rel: string, content: string | Buffer) {
  const abs = path.join(appRoot, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function writeManifest(assets: unknown[]) {
  stage("config/static-assets.json", JSON.stringify(assets));
}

describe("buildSeedSources", () => {
  it("indexes an app document prerender with its .rsc sibling and tags", () => {
    const sources = buildSeedSources([
      asset({
        pathname: "/blog/tim",
        filePath: ".next/server/app/blog/tim.html",
        headers: { "x-next-cache-tags": "_N_T_/blog/tim,_N_T_/blog", vary: "rsc" },
      }),
      asset({ pathname: "/blog/tim.rsc", filePath: ".next/server/app/blog/tim.rsc" }),
    ] as never);
    const source = sources.get("/blog/tim")!;
    expect(source.rscPath).toBe(".next/server/app/blog/tim.rsc");
    expect(source.tags).toEqual(["_N_T_/blog/tim", "_N_T_/blog"]);
    // The tag transport header must not leak into the served response headers.
    expect(Object.keys(source.headers)).toEqual(["vary"]);
  });

  it("registers the root prerender under both '/' and '/index'", () => {
    const sources = buildSeedSources([
      asset({ pathname: "/", filePath: ".next/server/app/index.html" }),
      asset({ pathname: "/.rsc", filePath: ".next/server/app/index.rsc" }),
    ] as never);
    expect(sources.get("/")).toBeDefined();
    expect(sources.get("/index")).toBe(sources.get("/"));
  });

  it("excludes PPR artifacts — their shells belong to the resume machinery", () => {
    const sources = buildSeedSources([
      asset({ pathname: "/ppr-page", filePath: ".next/server/app/ppr-page.html", ppr: true }),
    ] as never);
    expect(sources.size).toBe(0);
  });

  it("excludes non-prerender and non-app records", () => {
    const sources = buildSeedSources([
      asset({ pathname: "/pages-thing", filePath: ".next/server/pages/pages-thing.html" }),
      asset({ pathname: "/style.css", filePath: ".next/static/style.css", prerender: false }),
    ] as never);
    expect(sources.size).toBe(0);
  });
});

describe("createBuildSeedLookup", () => {
  it("returns an APP_PAGE entry with html, rscData, and the artifact mtime", async () => {
    writeManifest([
      asset({
        pathname: "/blog/tim",
        filePath: ".next/server/app/blog/tim.html",
        headers: { "x-next-cache-tags": "_N_T_/blog/tim" },
        status: 200,
      }),
      asset({ pathname: "/blog/tim.rsc", filePath: ".next/server/app/blog/tim.rsc" }),
    ]);
    stage(".next/server/app/blog/tim.html", "<html>built</html>");
    stage(".next/server/app/blog/tim.rsc", Buffer.from("rsc-payload"));

    const lookup = createBuildSeedLookup({ appRoot });
    const seed = await lookup("/blog/tim");
    expect(seed).not.toBeNull();
    expect(seed!.value.kind).toBe("APP_PAGE");
    expect(seed!.value.html).toContain("built");
    expect(Buffer.isBuffer(seed!.value.rscData)).toBe(true);
    expect(seed!.tags).toEqual(["_N_T_/blog/tim"]);
    expect(seed!.lastModified).toBeGreaterThan(0);
  });

  it("declines a prerender with no .rsc sibling rather than emit a half-usable entry", async () => {
    writeManifest([
      asset({ pathname: "/no-rsc", filePath: ".next/server/app/no-rsc.html" }),
    ]);
    stage(".next/server/app/no-rsc.html", "<html>x</html>");
    const lookup = createBuildSeedLookup({ appRoot });
    expect(await lookup("/no-rsc")).toBeNull();
  });

  it("misses for unknown keys and survives a missing manifest", async () => {
    const lookup = createBuildSeedLookup({ appRoot });
    expect(await lookup("/anything")).toBeNull();
  });
});
