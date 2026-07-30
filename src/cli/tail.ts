// src/cli/tail.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execCapture } from "./exec.js";
import { sanitizeForTerminal } from "./terminal.js";
import { assertSafeInfrastructure, infrastructurePath } from "./infrastructure-validation.js";

const COLORS = [
  "\x1b[36m", // cyan
  "\x1b[33m", // yellow
  "\x1b[32m", // green
  "\x1b[35m", // magenta
  "\x1b[34m", // blue
  "\x1b[91m", // bright red
  "\x1b[92m", // bright green
  "\x1b[93m", // bright yellow
  "\x1b[94m", // bright blue
  "\x1b[95m", // bright magenta
];
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";

export async function runTail(options: { projectDir: string; releaseName: string }): Promise<void> {
  const { projectDir, releaseName } = options;

  // Connect to the right cluster
  const infraPath = infrastructurePath(projectDir);
  if (existsSync(infraPath)) {
    let infra: { projectId?: string; region?: string };
    try {
      infra = JSON.parse(readFileSync(infraPath, "utf-8"));
      // S13: validate before these reach a gcloud/kubectl argv.
      assertSafeInfrastructure(infra);
    } catch (err) {
      // Name the file — a bare SyntaxError gives no clue WHICH file is corrupt.
      throw new Error(`Failed to parse ${infraPath}: ${(err as Error).message}`);
    }
    if (infra.projectId && infra.region) {
      const credResult = await execCapture("gcloud", [
        "container",
        "clusters",
        "get-credentials",
        `${releaseName}-cluster`,
        "--region",
        infra.region,
        "--project",
        infra.projectId,
        "--quiet",
      ]);
      if (credResult.exitCode !== 0) {
        console.error(`Failed to connect to cluster: ${credResult.stderr.trim()}`);
        process.exit(1);
      }
    }
  }

  // Assign colors per component
  const componentColors = new Map<string, string>();
  let colorIdx = 0;

  function getColor(component: string): string {
    if (!componentColors.has(component)) {
      componentColors.set(component, COLORS[colorIdx % COLORS.length]!);
      colorIdx++;
    }
    return componentColors.get(component)!;
  }

  // Track active log streams
  const activeStreams = new Map<string, ChildProcess>();

  function startTailing(podName: string, component: string) {
    if (activeStreams.has(podName)) return;

    const color = getColor(component);
    const shortId = podName.split("-").pop()!.slice(0, 5);
    const badge = `${component}/${shortId}`;

    const child = spawn("kubectl", ["logs", "-f", "--tail=10", podName], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (!line) continue;
        // L14: log lines are cluster-sourced — strip terminal control characters.
        const clean = sanitizeForTerminal(line);
        const isError =
          clean.includes("Error") || clean.includes("error") || clean.includes("FATAL");
        const lineColor = isError ? RED : "";
        process.stdout.write(
          `${color}${badge.padEnd(25)}${RESET} ${DIM}│${RESET} ${lineColor}${clean}${isError ? RESET : ""}\n`,
        );
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (!line || line.includes("is waiting to start")) continue;
        // L14: log lines are cluster-sourced — strip terminal control characters.
        const clean = sanitizeForTerminal(line);
        process.stderr.write(
          `${color}${badge.padEnd(25)}${RESET} ${DIM}│${RESET} ${RED}${clean}${RESET}\n`,
        );
      }
    });

    child.on("close", () => {
      activeStreams.delete(podName);
      process.stdout.write(`${DIM}${badge.padEnd(25)} │ (ended)${RESET}\n`);
      if (activeStreams.size === 0) {
        process.stdout.write(`${DIM}All streams ended. Waiting for new pods...${RESET}\n`);
      }
    });

    activeStreams.set(podName, child);
  }

  async function refreshPods() {
    const podsResult = await execCapture("kubectl", [
      "get",
      "pods",
      "-l",
      `app.kubernetes.io/name=${releaseName}`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}|{.metadata.labels.app\\.kubernetes\\.io/component}|{.status.phase}{"\\n"}{end}',
    ]);

    if (podsResult.exitCode !== 0 || !podsResult.stdout.trim()) return;

    const currentPods = new Set<string>();

    for (const line of podsResult.stdout.trim().split("\n")) {
      const [name, component, phase] = line.split("|");
      if (!name || !component) continue;
      currentPods.add(name);

      if (phase === "Running" && !activeStreams.has(name)) {
        const color = getColor(component);
        const shortId = name.split("-").pop()!.slice(0, 5);
        process.stdout.write(`${color}+ ${component}/${shortId}${RESET} ${DIM}(new pod)${RESET}\n`);
        startTailing(name, component);
      }
    }

    // Clean up streams for pods that no longer exist
    for (const [podName, child] of activeStreams) {
      if (!currentPods.has(podName)) {
        child.kill();
        activeStreams.delete(podName);
      }
    }
  }

  // Initial discovery
  await refreshPods();

  if (activeStreams.size === 0) {
    console.log(`${DIM}No running pods yet. Waiting for pods to start...${RESET}`);
  } else {
    console.log(`\nTailing ${activeStreams.size} pods across ${componentColors.size} workloads:`);
    for (const [component, color] of componentColors) {
      console.log(`  ${color}■${RESET} ${component}`);
    }
  }
  console.log(`${DIM}Watching for new pods every 5s. Ctrl+C to stop.${RESET}`);
  console.log(`${"─".repeat(60)}\n`);

  // Poll for new/removed pods — keeps the process alive even when all streams end
  const pollInterval = setInterval(refreshPods, 5_000);
  // Ensure the interval keeps the process alive (ref is default, but be explicit)
  if (pollInterval.ref) pollInterval.ref();

  // Clean up on exit
  const cleanup = () => {
    clearInterval(pollInterval);
    for (const child of activeStreams.values()) {
      child.kill();
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep alive
  await new Promise(() => {});
}
