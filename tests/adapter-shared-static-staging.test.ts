// tests/adapter-shared-static-staging.test.ts
//
// The shared-image strategy copies the whole distDir into `shared-context/<distDir>` in one `cp`,
// which already lands every distDir-resident static-manifest entry — `static/**` and each
// prerender's `.html`/`.segments`/`.meta` — at exactly the path the per-entry staging would use.
// stageFile does not dedupe against that copy (stagedPaths only records its own writes, and its
// exists-check skips a destination only when the realpaths MATCH), so re-staging the manifest
// copied the entire corpus a second time — on a 94k-route build, the very cost this staging pass
// exists to remove. Only `public/` is genuinely missing from the dist copy.
//
// copyFile is wrapped rather than stubbed: the build runs for real against a temp project, and the
// wrapper only records destinations so duplicate I/O is observable instead of inferred.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mockAppPage,
  mockOutputs,
  mockPrerender,
  mockRouting,
  mockStaticFile,
} from "./helpers/mock-outputs.js";
import type { K8sAdapterConfig } from "../src/types.js";

const copiedDestinations = vi.hoisted(() => [] as string[]);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: async (source: string, dest: string, mode?: number) => {
      copiedDestinations.push(String(dest));
      return actual.copyFile(source, dest, mode);
    },
  };
});

const { createK8sAdapter } = await import("../src/adapter.js");

const sharedConfig: K8sAdapterConfig = {
  pools: { ssr: { routes: ["appPages"] } },
  containerStrategy: "shared-image",
  provider: {
    gke: {
      gateway: {
        type: "gateway-api",
        className: "gke",
        hosts: [{ hostname: "example.com", tls: { enabled: true } }],
      },
    },
  },
};

let projectDir: string;
let bundleDir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["ADAPTER_K8S_BUNDLE_DIR", "ADAPTER_K8S_INTERNAL_SECRET_KEY", "SOURCE_DATE_EPOCH"];

beforeEach(() => {
  copiedDestinations.length = 0;
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  projectDir = mkdtempSync(path.join(os.tmpdir(), "adapter-shared-static-"));
  bundleDir = mkdtempSync(path.join(os.tmpdir(), "adapter-bundles-"));
  writeFileSync(path.join(bundleDir, "pool-server.cjs"), "// pool server");
  writeFileSync(path.join(bundleDir, "routing-service.cjs"), "// routing service");
  writeFileSync(path.join(bundleDir, "cache-handler.cjs"), "// cache handler");
  process.env.ADAPTER_K8S_BUNDLE_DIR = bundleDir;
  process.env.ADAPTER_K8S_INTERNAL_SECRET_KEY = "unit-test-key";
  process.env.SOURCE_DATE_EPOCH = "1750000000";
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(bundleDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key]!;
  }
});

const writeFile = (rel: string, content = "x") => {
  const abs = path.join(projectDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
};

/** One of every corpus shape the manifest carries: a build static file, a prerender with its
 * `.meta` sibling, and a public file (the only one the distDir copy cannot supply). */
function seedProject() {
  writeFile("package.json", JSON.stringify({ name: "app", type: "module" }));
  writeFile(".next/BUILD_ID", "b12345");
  writeFile(".next/server/app/page.js", "module.exports={}");
  writeFile(".next/static/chunk-a.js", "static-a");
  writeFile(".next/server/app/blog/post.html", "<html>post</html>");
  writeFile(".next/server/app/blog/post.meta", '{"status":200}');
  writeFile("public/logo.png", "png-bytes");
  writeFile("node_modules/next/package.json", JSON.stringify({ name: "next", version: "16.2.10" }));
  writeFile("node_modules/next/dist/server/setup-node-env.js", "//");
  return path.join(projectDir, ".next");
}

async function build() {
  const distDir = seedProject();
  const adapter = createK8sAdapter(structuredClone(sharedConfig));
  await adapter.onBuildComplete!({
    buildId: "b12345",
    routing: mockRouting(),
    outputs: mockOutputs({
      appPages: [
        mockAppPage({ pathname: "/", filePath: path.join(distDir, "server/app/page.js") }),
      ],
      staticFiles: [
        mockStaticFile({
          pathname: "/_next/static/chunk-a.js",
          filePath: path.join(distDir, "static/chunk-a.js"),
        }),
      ],
      prerenders: [
        mockPrerender({
          pathname: "/blog/post",
          fallback: { filePath: path.join(distDir, "server/app/blog/post.html") } as never,
        }),
      ],
    }),
    projectDir,
    repoRoot: projectDir,
    distDir,
    config: {},
    nextVersion: "16.2.0",
  } as never);
}

const sharedContext = (rel: string) =>
  path.join(projectDir, ".k8s-adapter/output/shared-context", rel);

describe("shared-image static staging", () => {
  it("does not re-copy the distDir corpus the wholesale dist copy already staged", async () => {
    await build();

    // Whatever the copy strategy, the image must still hold every manifest entry — that is the
    // property the per-entry staging pass exists for, and a filter must not erode it.
    const manifest = JSON.parse(
      readFileSync(sharedContext("config/static-assets.json"), "utf-8"),
    ) as Array<{ filePath: string }>;
    expect(manifest.map((entry) => entry.filePath).sort()).toEqual(
      [".next/static/chunk-a.js", ".next/server/app/blog/post.html", "public/logo.png"].sort(),
    );
    for (const entry of manifest) {
      expect(existsSync(sharedContext(entry.filePath)), entry.filePath).toBe(true);
    }
    // The prerender sibling reaches the image through the dist copy rather than stageFile.
    expect(readFileSync(sharedContext(".next/server/app/blog/post.meta"), "utf-8")).toBe(
      '{"status":200}',
    );

    // No SECOND write to any dist-resident entry: `cp` places them, and a copyFile to the same
    // destination would be the duplicate I/O this staging pass is supposed to avoid.
    const duplicated = copiedDestinations.filter((dest) =>
      [
        ".next/static/chunk-a.js",
        ".next/server/app/blog/post.html",
        ".next/server/app/blog/post.meta",
      ].some((rel) => dest === sharedContext(rel)),
    );
    expect(duplicated).toEqual([]);

    // public/ is the one shape the dist copy cannot supply, so it must still be staged per entry.
    expect(copiedDestinations).toContain(sharedContext("public/logo.png"));
    expect(readFileSync(sharedContext("public/logo.png"), "utf-8")).toBe("png-bytes");
  });
});
