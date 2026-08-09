// Found by the CLUSTER topology (scripts/e2e-cluster.sh), the only layer that runs the app
// from its actual container image. Deploying upstream's `middleware-responses` fixture to GKE
// CrashLooped every pool pod, twice, for the same structural reason:
//
//  1. Edge middleware found but sandbox not available, falling back to Node.js loading
//     Pool server failed to start: Configured middleware at .../edge-wrapper....js
//     has no callable export.
//
//     Probed inside the published image, the real cause was:
//       MODULE_NOT_FOUND Cannot find module '@swc/helpers/_/_interop_require_default'
//       Require stack: next/dist/shared/lib/constants.js <- .../web/sandbox/context.js
//
//  2. After fixing that, the sandbox loaded and the next one surfaced:
//       NOT READY: route module /_error failed to load ... Cannot find module 'styled-jsx'
//       Require stack: next/dist/compiled/next-server/pages-turbo.runtime.prod.js
//
// Both are the same gap. Next's server runtimes resolve certain packages at RUNTIME —
// the pool's own `appReq("next/dist/server/web/sandbox")`, turbopack's externalRequire —
// so no tracer walks into them, and the traced image shipped 8 top-level packages.
//
// Rather than name victims one CrashLoop at a time, the rule is: `next`'s OWN declared
// runtime dependencies ship beside `next`. Those are exactly the packages Next expects to
// resolve rather than bundle (@next/env, @swc/helpers, baseline-browser-mapping,
// caniuse-lite, postcss, styled-jsx — together a few MB against a several-hundred-MB image).
// Same category as @next/routing and the sharp bindings, which staging already names.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageNextRuntimeDependencies, stagedPaths, stagingFailures } from "../src/adapter.js";

let projectDir: string;

function writePkg(dir: string, pkg: Record<string, unknown>, files: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
}

/** An app whose installed `next` declares the runtime deps the real one does. */
function seedApp(
  nextDeps: Record<string, string> = { "@swc/helpers": "^0.5.15", "styled-jsx": "5.1.7" },
) {
  writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "app" }));
  const nm = path.join(projectDir, "node_modules");
  writePkg(path.join(nm, "next"), { name: "next", version: "16.3.0", dependencies: nextDeps });
  writePkg(
    path.join(nm, "@swc", "helpers"),
    { name: "@swc/helpers", version: "0.5.15" },
    { "_/_interop_require_default.js": "module.exports = {};" },
  );
  writePkg(path.join(nm, "styled-jsx"), { name: "styled-jsx", version: "5.1.7" });
}

const staged = (rel: string) =>
  existsSync(path.join(projectDir, ".k8s-adapter", "output", "pools", "ssr", "context", rel));

beforeEach(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), "next-runtime-deps-"));
  stagedPaths.clear();
  stagingFailures.length = 0;
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  stagedPaths.clear();
  stagingFailures.length = 0;
  vi.restoreAllMocks();
});

describe("staging next's runtime dependency closure", () => {
  it("stages into an explicit context dir when given one (the routing-service image)", async () => {
    // Full-run cluster (node-middleware, ~10 suites): a NODE-runtime middleware runs in the
    // ROUTING container, and its externalized `next` requires @swc/helpers at startup —
    // "Cannot find module '@swc/helpers/_/_interop_require_default'", routing pods
    // CrashLoop, every deploy of such an app times out at the rollout gate. The routing
    // context is not a pool context, so the staging needs an explicit destination.
    seedApp();
    const routingContext = path.join(projectDir, ".k8s-adapter", "routing-service", "context");

    const result = await stageNextRuntimeDependencies(
      projectDir,
      "routing-service",
      false,
      undefined,
      {
        stageDir: routingContext,
      },
    );

    expect(result.staged).toContain("@swc/helpers");
    expect(
      existsSync(
        path.join(routingContext, "node_modules/@swc/helpers/_/_interop_require_default.js"),
      ),
    ).toBe(true);
    expect(existsSync(path.join(routingContext, "node_modules/styled-jsx/package.json"))).toBe(
      true,
    );
  });

  it("stages @swc/helpers so the edge sandbox can load in the container", async () => {
    seedApp();

    const result = await stageNextRuntimeDependencies(projectDir, "ssr");

    expect(result.staged).toContain("@swc/helpers");
    expect(staged("node_modules/@swc/helpers/package.json")).toBe(true);
    // The exact subpath the published image failed on.
    expect(staged("node_modules/@swc/helpers/_/_interop_require_default.js")).toBe(true);
  });

  it("stages styled-jsx, which the Pages Router server runtime requires dynamically", async () => {
    seedApp();

    const result = await stageNextRuntimeDependencies(projectDir, "ssr");

    expect(result.staged).toContain("styled-jsx");
    expect(staged("node_modules/styled-jsx/package.json")).toBe(true);
  });

  it("walks REACT-DOM's dependency tree too (scheduler) — pages-router externals need it", async () => {
    // Phase-2 pilot, app-tree (Pages router): the pool image carried react-dom but NOT its
    // dependency `scheduler`, so the /_error route module failed to load react-dom/client and
    // the pod never became Ready ("Cannot find module 'scheduler'"). Same class as
    // @swc/helpers and styled-jsx: a package staged without its runtime dependency closure.
    // react/react-dom are next's peer deps, resolved from the APP at runtime by pages-router
    // externals — staging them means staging their trees.
    seedApp();
    const nm = path.join(projectDir, "node_modules");
    writePkg(
      path.join(nm, "react-dom"),
      { name: "react-dom", version: "19.2.0", dependencies: { scheduler: "^0.27.0" } },
      { "client.js": "module.exports = {};" },
    );
    writePkg(
      path.join(nm, "scheduler"),
      { name: "scheduler", version: "0.27.0" },
      {
        "index.js": "module.exports = {};",
      },
    );
    writePkg(path.join(nm, "react"), { name: "react", version: "19.2.0" });

    await stageNextRuntimeDependencies(projectDir, "ssr");

    expect(staged("node_modules/react-dom/package.json")).toBe(true);
    expect(staged("node_modules/scheduler/package.json")).toBe(true);
    expect(staged("node_modules/react/package.json")).toBe(true);
  });

  it("takes the dependency list from the APP's next, not a hardcoded list", async () => {
    // Next's dependency set moves between releases. Reading it from the installed package is
    // what keeps this fix from rotting into the same whack-a-mole it replaced.
    seedApp({ "styled-jsx": "5.1.7" });

    const result = await stageNextRuntimeDependencies(projectDir, "ssr");

    expect(result.staged).toEqual(["styled-jsx"]);
    expect(staged("node_modules/@swc/helpers/package.json")).toBe(false);
  });

  it("stages a Next dependency whose exports hide package.json", async () => {
    seedApp({ "locked-runtime": "1.0.0" });
    writePkg(
      path.join(projectDir, "node_modules", "locked-runtime"),
      { name: "locked-runtime", exports: { ".": "./dist/index.js" } },
      { "dist/index.js": "module.exports = {};" },
    );

    const result = await stageNextRuntimeDependencies(projectDir, "ssr");

    expect(result.staged).toContain("locked-runtime");
    expect(result.unresolved).not.toContain("locked-runtime");
    expect(staged("node_modules/locked-runtime/package.json")).toBe(true);
  });

  it("warns and continues when a declared dependency is unresolvable", async () => {
    // A pnpm/monorepo layout can hide one. Refusing to build the image over a package the app
    // may never load would be worse than the CrashLoop it prevents.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedApp();
    rmSync(path.join(projectDir, "node_modules", "styled-jsx"), { recursive: true, force: true });

    const result = await stageNextRuntimeDependencies(projectDir, "ssr", false, (dep, dir) =>
      dep === "styled-jsx" ? undefined : path.join(dir, "node_modules", ...dep.split("/")),
    );

    expect(result.staged).not.toContain("styled-jsx");
    // react/react-dom join the walk (see the scheduler test) and are equally unresolvable in
    // this fixture — the pinned behavior is "styled-jsx is reported, nothing throws".
    expect(result.unresolved).toContain("styled-jsx");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("styled-jsx"));
  });

  it("is a no-op when the app has no resolvable next", async () => {
    // Nothing to mirror. The build would already have failed elsewhere.
    writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "app" }));

    const result = await stageNextRuntimeDependencies(projectDir, "ssr");

    expect(result.staged).toEqual([]);
  });
});
