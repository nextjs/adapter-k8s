import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function packageManagerFamily(packageJson) {
  const declared =
    typeof packageJson?.packageManager === "string" ? packageJson.packageManager : "";
  if (declared.startsWith("npm@")) return "npm";
  if (declared.startsWith("pnpm@")) return "pnpm";
  // The adapter harness historically uses pnpm for undeclared fixtures because it is materially
  // faster across 1,000+ isolated installs. Only an explicit packageManager should override it.
  return "auto";
}

export function prepareFixturePackage(packageJson, adapterPackageName, adapterTarball) {
  const prepared = structuredClone(packageJson);
  prepared.dependencies = prepared.dependencies || {};
  prepared.dependencies[adapterPackageName] = `file:${adapterTarball}`;
  // The harness pins TypeScript to `latest`, currently TS 7, which Next cannot verify yet.
  for (const dependencies of [prepared.dependencies, prepared.devDependencies]) {
    if (dependencies?.typescript === "latest") dependencies.typescript = "^6";
  }
  // Next's deploy harness appends this marker command with pnpm even when the fixture explicitly
  // declares npm. Rewrite only that exact harness suffix; user-authored build commands are left as-is.
  if (packageManagerFamily(prepared) === "npm" && prepared.scripts?.build) {
    prepared.scripts.build = prepared.scripts.build.replace(
      /\s*&&\s*pnpm post-build\s*$/,
      " && npm run post-build",
    );
  }
  return prepared;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "prepare") {
    const packagePath = process.argv[3] ?? "package.json";
    const prepared = prepareFixturePackage(
      JSON.parse(readFileSync(packagePath, "utf8")),
      process.argv[4],
      process.argv[5],
    );
    writeFileSync(packagePath, `${JSON.stringify(prepared, null, 2)}\n`);
  } else {
    const packagePath = process.argv[2] ?? "package.json";
    process.stdout.write(packageManagerFamily(JSON.parse(readFileSync(packagePath, "utf8"))));
  }
}
