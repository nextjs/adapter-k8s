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

describe("filesystem-mirror seeds (PPR shells, segments — sub-shell-generation family)", () => {
  // `next start`'s FileSystemCache serves ROUTE-KEYED fallback shells straight from
  // `.next/server/app/<key>.html` + `.meta` (postponed state, headers, segmentPaths). With a
  // custom handler those keys always missed and PPR routes rendered fully dynamically under
  // the production config — the k3d full-run PPR cluster (sub-shell-generation 6/7 failing:
  // "Root Layout: (runtime)" where "(buildtime)" is expected). Mirror the fs-cache read for
  // keys the static-assets manifest doesn't carry.
  it("serves a route-keyed PPR fallback shell with its postponed state and NO rscData", async () => {
    writeManifest([]);
    stage(".next/server/app/[lang]/[slug].html", "<html>shell</html>");
    stage(
      ".next/server/app/[lang]/[slug].meta",
      JSON.stringify({
        status: 200,
        postponed: "POSTPONED_STATE_TOKEN",
        headers: { "x-next-cache-tags": "_N_T_/layout,_N_T_/[lang]/[slug]/page" },
      }),
    );
    const lookup = createBuildSeedLookup({ appRoot });

    const entry = await lookup("/[lang]/[slug]", { kind: "APP_PAGE", isRoutePPREnabled: true });

    expect(entry).not.toBeNull();
    expect(entry!.value.kind).toBe("APP_PAGE");
    expect(String(entry!.value.html)).toContain("shell");
    expect(entry!.value.postponed).toBe("POSTPONED_STATE_TOKEN");
    // fs-cache reads rscData only when there is no postponed state (file-system-cache.js:167).
    expect(entry!.value.rscData).toBeUndefined();
    expect(entry!.tags).toContain("_N_T_/layout");
  });

  it("collects segmentData from the .segments directory like the fs cache", async () => {
    // Filenames mirror a REAL build artifact (`<key>.segments/_tree.segment.rsc`,
    // nested `<key>.segments/<path>/__PAGE__.segment.rsc` — RSC_SEGMENT_SUFFIX is
    // `.segment.rsc`, NOT `.rsc`). An earlier version of this test staged `.rsc` names
    // copied from the implementation's wrong assumption and masked the bug: every real
    // segment file was silently missed.
    writeManifest([]);
    stage(".next/server/app/[lang]/[slug].html", "<html>shell</html>");
    stage(
      ".next/server/app/[lang]/[slug].meta",
      JSON.stringify({
        status: 200,
        postponed: "P",
        segmentPaths: ["/_tree", "/[lang]/[slug]/__PAGE__"],
      }),
    );
    stage(".next/server/app/[lang]/[slug].segments/_tree.segment.rsc", "tree-segment");
    stage(
      ".next/server/app/[lang]/[slug].segments/[lang]/[slug]/__PAGE__.segment.rsc",
      "page-segment",
    );
    const lookup = createBuildSeedLookup({ appRoot });

    const entry = await lookup("/[lang]/[slug]", { kind: "APP_PAGE", isRoutePPREnabled: true });

    expect(entry).not.toBeNull();
    const segs = entry!.value.segmentData as Map<string, Buffer>;
    expect(segs).toBeInstanceOf(Map);
    expect(String(segs.get("/_tree"))).toBe("tree-segment");
    expect(String(segs.get("/[lang]/[slug]/__PAGE__"))).toBe("page-segment");
    // A segmentPath whose file is absent is skipped (dynamic, no prefetch) — not an error.
    expect(segs.has("/missing")).toBe(false);
  });

  it("serves a fallback read without rscData even when no .rsc exists (fs-cache gate)", async () => {
    // FileSystemCache.get reads rscData only when `!isFallback && (!isRoutePPREnabled ||
    // postponed == null)`. A fallback read must not require (or load) the .rsc file —
    // requiring it turned valid fallback HTML seeds into misses.
    writeManifest([]);
    stage(".next/server/app/[slug].html", "<html>fallback</html>");
    stage(".next/server/app/[slug].meta", JSON.stringify({ status: 200, headers: {} }));
    const lookup = createBuildSeedLookup({ appRoot });

    const entry = await lookup("/[slug]", {
      kind: "APP_PAGE",
      isFallback: true,
      isRoutePPREnabled: true,
    });

    expect(entry).not.toBeNull();
    expect(String(entry!.value.html)).toContain("fallback");
    expect(entry!.value.rscData).toBeUndefined();
  });

  it("reads rscData for a non-postponed app page found only on disk", async () => {
    writeManifest([]);
    stage(".next/server/app/plain.html", "<html>plain</html>");
    stage(".next/server/app/plain.meta", JSON.stringify({ status: 200, headers: {} }));
    stage(".next/server/app/plain.rsc", "flight-bytes");
    const lookup = createBuildSeedLookup({ appRoot });

    const entry = await lookup("/plain", { kind: "APP_PAGE" });

    expect(entry).not.toBeNull();
    expect(String(entry!.value.rscData)).toBe("flight-bytes");
  });

  it("declines a non-postponed page whose .rsc is missing (half-usable) and unknown keys", async () => {
    writeManifest([]);
    stage(".next/server/app/broken.html", "<html>x</html>");
    const lookup = createBuildSeedLookup({ appRoot });

    expect(await lookup("/broken", { kind: "APP_PAGE" })).toBeNull();
    expect(await lookup("/nope", { kind: "APP_PAGE" })).toBeNull();
  });

  it("manifest-based seeds still take precedence for keys they cover", async () => {
    writeManifest([
      asset({
        pathname: "/covered",
        filePath: ".next/server/app/covered.html",
        headers: { "x-next-cache-tags": "manifest-tag" },
      }),
      asset({ pathname: "/covered.rsc", filePath: ".next/server/app/covered.rsc" }),
    ]);
    stage(".next/server/app/covered.html", "<html>covered</html>");
    stage(".next/server/app/covered.rsc", "rsc");
    stage(".next/server/app/covered.meta", JSON.stringify({ headers: { "x-next-cache-tags": "disk-tag" } }));
    const lookup = createBuildSeedLookup({ appRoot });

    const entry = await lookup("/covered", { kind: "APP_PAGE" });
    expect(entry!.tags).toContain("manifest-tag");
    expect(entry!.tags).not.toContain("disk-tag");
  });
});
