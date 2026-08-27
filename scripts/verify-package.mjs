import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const projectDir = process.cwd();
const scratchDir = mkdtempSync(path.join(tmpdir(), "adapter-k8s-package-test-"));

function run(command, args, { cwd = projectDir, env, ...options } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    ...options,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...env },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "no exit status"})\n` +
        `${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result;
}

try {
  const pack = run("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--silent",
    "--pack-destination",
    scratchDir,
  ]);
  const receipt = JSON.parse(pack.stdout);
  assert.equal(receipt.length, 1, "npm pack must produce exactly one artifact");

  const tarball = path.join(scratchDir, receipt[0].filename);
  assert.ok(existsSync(tarball), `missing packed artifact ${tarball}`);
  run("tar", ["-xzf", tarball, "-C", scratchDir]);

  const packageDir = path.join(scratchDir, "package");
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const sourceManifest = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8"));
  assert.equal(manifest.name, "@next-community/adapter-k8s");
  assert.equal(manifest.version, sourceManifest.version);
  assert.deepEqual(manifest.publishConfig, {
    access: "public",
    provenance: true,
    registry: "https://registry.npmjs.org/",
  });

  const packedPaths = new Set(receipt[0].files.map((file) => file.path));
  const required = [
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/composition-plan.js",
    "dist/composition-plan.d.ts",
    "dist/internal.js",
    "dist/internal.d.ts",
    "dist/cli.cjs",
    "dist/pool-server.cjs",
    "dist/routing-service.cjs",
    "dist/cache-handler.cjs",
    "dist/cutover-job.cjs",
    "docker/cutover-job.Dockerfile",
    "docs/targets.md",
    "skills/deploy/SKILL.md",
  ];
  for (const file of required) {
    assert.ok(packedPaths.has(file), `published package is missing ${file}`);
  }
  for (const file of packedPaths) {
    assert.ok(
      !["src/", "tests/", ".github/", ".claude/", ".k8s-adapter/"].some((prefix) =>
        file.startsWith(prefix),
      ),
      `private development path escaped into the package: ${file}`,
    );
  }

  const consumerDir = path.join(scratchDir, "consumer");
  mkdirSync(consumerDir);
  writeFileSync(
    path.join(consumerDir, "package.json"),
    JSON.stringify({ name: "adapter-k8s-package-surface-consumer", private: true, type: "module" }),
  );
  const supportedNext = sourceManifest.dependencies["@next/routing"];
  assert.match(supportedNext, /^\d+\.\d+\.\d+/, "@next/routing must pin a concrete Next line");
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
      `next@${supportedNext}`,
    ],
    { cwd: consumerDir },
  );

  const consumerRequire = createRequire(path.join(consumerDir, "package.json"));
  const imported = new Map();
  for (const exportName of Object.keys(manifest.exports)) {
    const specifier =
      exportName === "."
        ? manifest.name
        : exportName === "./package.json"
          ? `${manifest.name}/package.json`
          : `${manifest.name}/${exportName.slice(2)}`;
    const resolved = consumerRequire.resolve(specifier);
    imported.set(
      exportName,
      exportName === "./package.json"
        ? consumerRequire(resolved)
        : await import(pathToFileURL(resolved).href),
    );
  }

  const packageModule = imported.get(".");
  assert.equal(typeof packageModule.createK8sAdapter, "function");
  assert.equal(typeof packageModule.defineTarget, "function");
  assert.equal(
    packageModule.compileTarget,
    undefined,
    "unstable target compilation must not leak from the root export",
  );

  const internalModule = imported.get("./internal");
  assert.equal(typeof internalModule.compileTarget, "function");
  assert.equal(typeof internalModule.parseAndVerifyCompositionPlan, "function");

  const planModule = imported.get("./composition-plan");
  assert.equal(planModule.COMPOSITION_PLAN_API_VERSION, "adapter-k8s.nextjs.org/v1alpha1");
  assert.deepEqual(Object.keys(planModule), ["COMPOSITION_PLAN_API_VERSION"]);

  const installedManifest = imported.get("./package.json");
  assert.equal(installedManifest.name, manifest.name);
  assert.equal(installedManifest.version, manifest.version);

  const cli = run(path.join(consumerDir, "node_modules", ".bin", "adapter-k8s"), ["--help"], {
    cwd: consumerDir,
  });
  assert.match(cli.stdout, /adapter-k8s/);

  console.log(
    `Verified ${manifest.name}@${manifest.version}: ${packedPaths.size} files, ` +
      `${receipt[0].size} packed bytes`,
  );
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
