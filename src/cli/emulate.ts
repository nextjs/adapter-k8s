// src/cli/emulate.ts
//
// Spins up the full adapter infrastructure locally:
//   Envoy (:8080) → Routing Service ext_proc (:8443) → Pool Server (:3000)
//
// Usage: npx adapter-k8s emulate [--skip-build] [--port 8080]

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execCapture, execOrThrow } from "./exec.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

interface EmulateOptions {
  projectDir: string;
  skipBuild?: boolean;
  port?: number;
}

export async function runEmulate(options: EmulateOptions): Promise<void> {
  const { projectDir, skipBuild, port = 8080 } = options;
  const children: ChildProcess[] = [];

  // __dirname in the bundled CLI is the dist/ directory itself.
  const distDir = __dirname;

  console.log(`
${BOLD}${CYAN}adapter-k8s emulate${RESET}
${DIM}Local infrastructure emulation — replicates GKE deployment locally${RESET}

  ${CYAN}Envoy${RESET}             :${port}  ${DIM}(ALB + ext_proc)${RESET}
  ${CYAN}Routing Service${RESET}   :8443 ${DIM}(ext_proc gRPC — middleware + route resolution)${RESET}
  ${CYAN}Pool Server${RESET}       :3000 ${DIM}(handler invocation)${RESET}
`);

  // --- 1. Build if needed ---
  if (!skipBuild) {
    console.log(`${DIM}[build]${RESET} Running next build...`);
    await execOrThrow("npx", ["next", "build"], { cwd: projectDir });
  }

  const outputDir = path.join(projectDir, ".k8s-adapter", "output");
  if (!existsSync(outputDir)) {
    console.error(`${RED}No build output found at ${outputDir}${RESET}`);
    console.error(`Run ${BOLD}npx next build${RESET} with NEXT_ADAPTER_PATH set first.`);
    process.exit(1);
  }

  const buildMetaPath = path.join(outputDir, "build-metadata.json");
  const buildId = existsSync(buildMetaPath)
    ? JSON.parse(readFileSync(buildMetaPath, "utf-8")).buildId
    : "local";

  // --- 2. Copy configs (always refresh from build output) ---
  const configDir = path.join(projectDir, "config");
  {
    const { mkdirSync, copyFileSync } = await import("node:fs");
    mkdirSync(configDir, { recursive: true });
    // Copy manifests from build output
    const manifest = path.join(outputDir, "routing-manifest.json");
    if (existsSync(manifest)) copyFileSync(manifest, path.join(configDir, "routing-manifest.json"));
    const staticAssets = path.join(outputDir, "static-assets.json");
    if (existsSync(staticAssets)) copyFileSync(staticAssets, path.join(configDir, "static-assets.json"));
    // Copy pool manifests
    const { readdirSync } = await import("node:fs");
    for (const f of readdirSync(outputDir)) {
      if (f.startsWith("pool-manifest-")) {
        copyFileSync(path.join(outputDir, f), path.join(configDir, f));
      }
    }
    // Also check in pool context dirs
    const poolsDir = path.join(outputDir, "pools");
    if (existsSync(poolsDir)) {
      for (const pool of readdirSync(poolsDir)) {
        const ctxConfig = path.join(poolsDir, pool, "context", "config");
        if (existsSync(ctxConfig)) {
          for (const f of readdirSync(ctxConfig)) {
            const dest = path.join(configDir, f);
            if (!existsSync(dest)) copyFileSync(path.join(ctxConfig, f), dest);
          }
        }
      }
    }
  }

  // --- 3. Start Pool Server ---
  console.log(`${DIM}[pool-server]${RESET} Starting on :3000...`);
  const poolServer = spawn("node", [path.join(distDir, "pool-server.cjs")], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: "3000",
      POOL_NAME: "default",
      NEXT_BUILD_ID: buildId,
      CONFIG_DIR: configDir,
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(poolServer);

  poolServer.stdout?.on("data", (d) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      console.log(`  ${GREEN}pool-server${RESET}       ${DIM}│${RESET} ${line}`);
    }
  });
  poolServer.stderr?.on("data", (d) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      console.error(`  ${GREEN}pool-server${RESET}       ${DIM}│${RESET} ${RED}${line}${RESET}`);
    }
  });

  // --- 4. Start Routing Service ---
  console.log(`${DIM}[routing-service]${RESET} Starting on :8443...`);
  const routingService = spawn("node", [path.join(distDir, "routing-service.cjs")], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: "8443",
      NEXT_BUILD_ID: buildId,
      CONFIG_DIR: configDir,
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(routingService);

  routingService.stdout?.on("data", (d) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      console.log(`  ${CYAN}routing-service${RESET}   ${DIM}│${RESET} ${line}`);
    }
  });
  routingService.stderr?.on("data", (d) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      console.error(`  ${CYAN}routing-service${RESET}   ${DIM}│${RESET} ${RED}${line}${RESET}`);
    }
  });

  // --- 5. Start Envoy ---
  const envoyConfig = path.resolve(__dirname, "..", "integration", "envoy.yaml");
  // Try bundled config, fallback to adapter package
  const envoyYaml = existsSync(envoyConfig)
    ? envoyConfig
    : path.join(distDir, "..", "integration", "envoy.yaml");

  let envoyChild: ChildProcess | null = null;

  console.log(`${DIM}[envoy]${RESET} Config: ${envoyYaml} (exists: ${existsSync(envoyYaml)})`) ;
  if (existsSync(envoyYaml)) {
    // Check for local envoy or docker
    // Check for Envoy PROXY binary (not `envoy` the SSH agent manager)
    // The real Envoy proxy responds to `--version` with "envoy version:"
    const envoyCheck = await execCapture("envoy", ["--version"]).catch(() => null);
    const isEnvoyProxy = envoyCheck && envoyCheck.exitCode === 0 &&
      (envoyCheck.stdout + envoyCheck.stderr).includes("version:");
    if (isEnvoyProxy) {
      console.log(`${DIM}[envoy]${RESET} Starting on :${port} (local binary)...`);
      envoyChild = spawn("envoy", ["-c", envoyYaml, "--log-level", "warn"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      console.log(`${DIM}[envoy]${RESET} Starting on :${port} (docker)...`);
      envoyChild = spawn("docker", [
        "run", "--rm", "--network", "host",
        "--name", "adapter-k8s-envoy",
        "-v", `${envoyYaml}:/etc/envoy/envoy.yaml:ro`,
        "envoyproxy/envoy:v1.32-latest",
        "--log-level", "warn",
      ], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

    children.push(envoyChild);

    envoyChild.stdout?.on("data", (d) => {
      for (const line of d.toString().split("\n").filter(Boolean)) {
        console.log(`  ${YELLOW}envoy${RESET}             ${DIM}│${RESET} ${line}`);
      }
    });
    envoyChild.stderr?.on("data", (d) => {
      for (const line of d.toString().split("\n").filter(Boolean)) {
        console.error(`  ${YELLOW}envoy${RESET}             ${DIM}│${RESET} ${line}`);
      }
    });
  } else {
    console.log(`${YELLOW}[envoy]${RESET} No envoy.yaml found — running without Envoy proxy`);
    console.log(`${DIM}        Requests go directly to pool server on :3000${RESET}`);
  }

  // --- 6. Wait for services ---
  console.log(`\n${DIM}Waiting for services...${RESET}`);
  const ports = [3000, 8443];
  if (envoyChild) ports.push(port);

  for (let attempt = 0; attempt < 60; attempt++) {
    let allReady = true;
    for (const p of ports) {
      const ok = await new Promise<boolean>((resolve) => {
        const s = require("net").createConnection(p, "127.0.0.1");
        s.on("connect", () => { s.destroy(); resolve(true); });
        s.on("error", () => resolve(false));
        setTimeout(() => resolve(false), 300);
      });
      if (!ok) { allReady = false; break; }
    }
    if (allReady) break;

    // Check for crashes — Envoy failing is non-fatal, pool/routing crashing is fatal
    if (poolServer.exitCode !== null) {
      console.error(`${RED}Pool server crashed. Check logs above.${RESET}`);
      cleanup(children);
      process.exit(1);
    }
    if (routingService.exitCode !== null) {
      console.error(`${RED}Routing service crashed. Check logs above.${RESET}`);
      cleanup(children);
      process.exit(1);
    }
    if (envoyChild && envoyChild.exitCode !== null) {
      console.log(`${YELLOW}[envoy]${RESET} Envoy exited — continuing without proxy. Requests go to pool server on :3000`);
      children.splice(children.indexOf(envoyChild), 1);
      envoyChild = null;
      // Remove envoy port from check list
      const envoyIdx = ports.indexOf(port);
      if (envoyIdx >= 0) ports.splice(envoyIdx, 1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const url = envoyChild ? `http://localhost:${port}` : "http://localhost:3000";

  console.log(`
${GREEN}${BOLD}Ready!${RESET}

  ${BOLD}${url}${RESET}

  ${DIM}Request flow:${RESET}
  ${DIM}Client → Envoy (:${port}) → Routing Service ext_proc (:8443) → Pool Server (:3000)${RESET}

  ${DIM}Press Ctrl+C to stop all services.${RESET}
`);

  // --- 7. Keep alive + cleanup ---
  const shutdown = () => {
    console.log(`\n${DIM}Shutting down...${RESET}`);
    cleanup(children);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Monitor for crashes
  for (const child of children) {
    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`${RED}Service exited with code ${code}${RESET}`);
      }
    });
  }

  await new Promise(() => {});
}

function cleanup(children: ChildProcess[]) {
  for (const child of children) {
    child.kill("SIGTERM");
  }
  // Kill docker envoy container if running
  spawn("docker", ["rm", "-f", "adapter-k8s-envoy"], { stdio: "ignore" });
}
