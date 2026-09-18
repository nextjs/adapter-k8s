import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { execCapture, execCaptureOrThrow } from "../../../src/cli/exec.js";

/** Build twice from the published file set, then expose the real pool and next start. */
export async function continuityBuilds() {
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const fixture = path.join(repo, "fixtures/main");
  const version = process.env.E2E_CONTINUITY_NEXT_VERSION;
  if (!version || !/^16\.3\.\d+$/.test(version))
    throw new Error("Pin E2E_CONTINUITY_NEXT_VERSION to a supported stable release, e.g. 16.3.4");
  const root = mkdtempSync(path.join(tmpdir(), "adapter-continuity-builds-"));
  const deploymentId = (marker: string) =>
    process.env.E2E_CONTINUITY_DEPLOYMENT_IDS === "1" ? `continuity-${marker}` : "";
  const children: { controller: AbortController; lifetime: Promise<void> }[] = [];
  const origins: Record<string, { A: string; B: string }> = {
    pool: { A: "", B: "" },
    next: { A: "", B: "" },
  };
  const cleanup = async () => {
    for (const child of children) child.controller.abort();
    await Promise.all(children.map((c) => c.lifetime));
    if (process.env.E2E_CONTINUITY_KEEP === "1") console.log(`Continuity artifacts: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  };
  try {
    if (!existsSync(path.join(repo, "dist/pool-server.cjs")))
      throw new Error("Run npm run build before the continuity suite");
    const packed = await execCaptureOrThrow(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", root],
      { cwd: repo, timeoutMs: 60_000 },
    );
    const tarball = path.join(root, JSON.parse(packed)[0].filename);
    for (const marker of ["A", "B"] as const) {
      const app = path.join(root, marker);
      mkdirSync(app);
      for (const name of ["app", "pages", "public", "proxy.ts", "next.config.ts", "tsconfig.json"])
        cpSync(path.join(fixture, name), path.join(app, name), { recursive: true });
      const pkg = JSON.parse(readFileSync(path.join(fixture, "package.json"), "utf8"));
      pkg.dependencies.next = version;
      pkg.dependencies["@next-community/adapter-k8s"] = `file:${tarball}`;
      writeFileSync(path.join(app, "package.json"), JSON.stringify(pkg));
      writeFileSync(
        path.join(app, "adapter.config.mjs"),
        `import { createK8sAdapter } from "@next-community/adapter-k8s";
export default createK8sAdapter({ cache: { enabled: false }, compression: { enabled: false },
  pools: { default: { routes: ["appPages", "appRoutes", "pages", "pagesApi"] } },
  provider: { gke: { gateway: { type: "gateway-api", className: "gke-l7-global-external-managed",
    hosts: [{ hostname: "continuity.invalid", tls: { enabled: false } }] } } }
});\n`,
      );
      await execCaptureOrThrow("npm", ["install", "--include=dev", "--no-audit", "--no-fund"], {
        cwd: app,
        timeoutMs: 300_000,
      });
      const built = await execCapture("npm", ["run", "build"], {
        cwd: app,
        timeoutMs: 300_000,
        env: {
          NEXT_PUBLIC_CONTINUITY_VERSION: marker,
          NEXT_DEPLOYMENT_ID: deploymentId(marker),
          ADAPTER_K8S_SKIP_STAGING: "1",
          ADAPTER_K8S_BUILD_CPUS: "4",
        },
      });
      writeFileSync(path.join(root, `build-${marker}.log`), built.stdout + built.stderr);
      if (built.exitCode !== 0)
        throw new Error(`Continuity build ${marker} failed: ${built.stdout}\n${built.stderr}`);
    }
    for (const marker of ["A", "B"] as const)
      for (const runtime of ["pool", "next"]) {
        const app = path.join(root, marker);
        const portFile = path.join(root, `${runtime}-${marker}.port`);
        const preload = path.join(root, `${runtime}-${marker}.mjs`);
        // Both entrypoints publish their kernel-assigned port in stdout. Observe that same
        // contract as e2e-deploy.sh rather than probing/releasing a supposedly free port.
        writeFileSync(
          preload,
          `import { writeFileSync } from 'node:fs';
const original = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  const text = String(chunk).replace(/\\x1b\\[[0-9;]*m/g, '');
  const match = text.match(${runtime === "pool" ? "/Pool server listening on port (\\d+)/" : "/http:\\/\\/127\\.0\\.0\\.1:(\\d+)/"});
  if (match) writeFileSync(${JSON.stringify(portFile)}, match[1]);
  return original(chunk, ...args);
};\n`,
        );
        const controller = new AbortController();
        const meta = JSON.parse(
          readFileSync(path.join(app, ".k8s-adapter/output/build-metadata.json"), "utf8"),
        );
        const args =
          runtime === "pool"
            ? ["node_modules/@next-community/adapter-k8s/dist/pool-server.cjs"]
            : ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", "0"];
        let exited = false;
        const lifetime = execCapture(process.execPath, ["--import", preload, ...args], {
          cwd: app,
          signal: controller.signal,
          timeoutMs: 600_000,
          env: {
            NODE_ENV: "production",
            NEXT_DEPLOYMENT_ID: deploymentId(marker),
            PORT: "0",
            POOL_NAME: "default",
            NEXT_BUILD_ID: meta.buildId,
            CONFIG_DIR: path.join(app, ".k8s-adapter/output"),
            ADAPTER_K8S_LISTEN_HOST: "127.0.0.1",
          },
        }).then(
          (r) => {
            exited = true;
            writeFileSync(path.join(root, `${runtime}-${marker}.log`), r.stdout + r.stderr);
          },
          (error) => {
            exited = true;
            if (!controller.signal.aborted)
              writeFileSync(path.join(root, `${runtime}-${marker}.log`), String(error));
          },
        );
        children.push({ controller, lifetime });
        const deadline = Date.now() + 30_000;
        while (!existsSync(portFile)) {
          if (exited || Date.now() > deadline)
            throw new Error(`${runtime} ${marker} failed to listen; artifacts: ${root}`);
          await delay(50);
        }
        origins[runtime]![marker] = `http://127.0.0.1:${Number(readFileSync(portFile, "utf8"))}`;
      }
    return { origins, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
