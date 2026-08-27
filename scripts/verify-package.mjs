import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const projectDir = process.cwd();
const scratchDir = mkdtempSync(path.join(projectDir, ".package-test-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    encoding: "utf8",
    ...options,
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

  const packageModule = await import(pathToFileURL(path.join(packageDir, "dist/index.js")).href);
  assert.equal(typeof packageModule.createK8sAdapter, "function");
  assert.equal(typeof packageModule.defineTarget, "function");
  assert.equal(
    packageModule.compileTarget,
    undefined,
    "unstable target compilation must not leak from the root export",
  );

  const cli = run(process.execPath, [path.join(packageDir, "dist/cli.cjs"), "--help"], {
    cwd: packageDir,
  });
  assert.match(cli.stdout, /adapter-k8s/);

  const consumerDir = path.join(scratchDir, "consumer");
  const scopeDir = path.join(consumerDir, "node_modules", "@next-community");
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(
    path.join(consumerDir, "package.json"),
    JSON.stringify({ name: "adapter-k8s-package-surface-consumer", private: true }),
  );
  symlinkSync(packageDir, path.join(scopeDir, "adapter-k8s"), "dir");
  const consumerRequire = createRequire(path.join(consumerDir, "package.json"));
  assert.equal(
    realpathSync(consumerRequire.resolve("@next-community/adapter-k8s")),
    realpathSync(path.join(packageDir, "dist/index.js")),
    "createRequire.resolve must find adapterPath through the default export condition",
  );

  const internalPath = consumerRequire.resolve("@next-community/adapter-k8s/internal");
  const internalModule = await import(pathToFileURL(internalPath).href);
  assert.equal(typeof internalModule.compileTarget, "function");
  assert.equal(typeof internalModule.parseAndVerifyCompositionPlan, "function");

  const planPath = consumerRequire.resolve("@next-community/adapter-k8s/composition-plan");
  const planModule = await import(pathToFileURL(planPath).href);
  assert.equal(planModule.COMPOSITION_PLAN_API_VERSION, "adapter-k8s.nextjs.org/v1alpha1");
  assert.deepEqual(Object.keys(planModule), ["COMPOSITION_PLAN_API_VERSION"]);

  console.log(
    `Verified ${manifest.name}@${manifest.version}: ${packedPaths.size} files, ` +
      `${receipt[0].size} packed bytes`,
  );
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
