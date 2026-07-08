import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const runBaseline = process.env.RUN_APPHOSTING_BASELINE_E2E === "1";
const describeIf = runBaseline ? describe : describe.skip;

const nextVersion = process.env.APPHOSTING_BASELINE_NEXT_VERSION ?? "16.2.1";
const reactVersion = process.env.APPHOSTING_BASELINE_REACT_VERSION ?? "19.2.4";
const adapterVersion = process.env.APPHOSTING_BASELINE_ADAPTER_VERSION ?? "latest";

let tempDir: string | null = null;

function runOrThrow(
  command: string,
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      [`Command failed: ${command} ${args.join(" ")}`, result.stdout?.trim(), result.stderr?.trim()]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  return result;
}

function readRunCommand(bundleYamlPath: string) {
  const bundleYaml = readFileSync(bundleYamlPath, "utf8");
  const match = bundleYaml.match(/^\s*runCommand:\s*(.+)\s*$/m);
  if (!match?.[1]) {
    throw new Error(`Could not find runCommand in ${bundleYamlPath}`);
  }
  return match[1].trim();
}

describeIf("apphosting standalone baseline", () => {
  afterAll(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("builds a standalone app with the npm adapter", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "apphosting-standalone-"));

    writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify(
        {
          name: "apphosting-standalone-baseline",
          private: true,
          type: "module",
          dependencies: {
            next: nextVersion,
            react: reactVersion,
            "react-dom": reactVersion,
            "@apphosting/adapter-nextjs": adapterVersion,
          },
        },
        null,
        2,
      ),
    );

    writeFileSync(
      path.join(tempDir, "next.config.mjs"),
      "export default { output: 'standalone' };\n",
    );

    mkdirSync(path.join(tempDir, "app", "api", "hello"), { recursive: true });
    writeFileSync(
      path.join(tempDir, "app", "page.jsx"),
      [
        "export default function Page() {",
        '  return <main id="home">apphosting-standalone-baseline</main>;',
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(tempDir, "app", "api", "hello", "route.js"),
      [
        "export function GET() {",
        "  return Response.json({ ok: true, adapter: '@apphosting/adapter-nextjs' });",
        "}",
        "",
      ].join("\n"),
    );

    runOrThrow("npm", ["install"], tempDir);
    runOrThrow("npx", ["apphosting-adapter-nextjs-build"], tempDir, {
      FRAMEWORK_VERSION: nextVersion,
    });

    const standaloneServer = path.join(tempDir, ".next", "standalone", "server.js");
    expect(existsSync(standaloneServer)).toBe(true);
    expect(existsSync(path.join(tempDir, ".apphosting", "bundle.yaml"))).toBe(true);

    const runCommand = readRunCommand(path.join(tempDir, ".apphosting", "bundle.yaml"));
    expect(runCommand).toContain("server.js");

    const installedPackage = JSON.parse(
      readFileSync(
        path.join(tempDir, "node_modules", "@apphosting", "adapter-nextjs", "package.json"),
        "utf8",
      ),
    );
    expect(typeof installedPackage.version).toBe("string");
    expect(installedPackage.version.length).toBeGreaterThan(0);
  }, 240_000);
});
