import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderRouteExtUpdateJob } from "../../../src/emit/templates/route-ext-update-job.js";

const document = `name: "my-app-traffic-ext"
forwardingRules:
  FORWARDING_RULE_PLACEHOLDER
extensionChains:
  - matchCondition:
      celExpression: "true"
    extensions:
      - name: "routing-service"
        service: "projects/p-123456/global/backendServices/my-app-routing-service"
        authority: "my-app-routing-service.default.svc.cluster.local"
`;

function register(swap: "none" | "after-expansion" | "after-verification") {
  const dir = mkdtempSync(path.join(tmpdir(), "route-ext-snapshot-"));
  try {
    const bin = path.join(dir, "bin");
    const config = path.join(dir, "config");
    const jobTmp = path.join(dir, "tmp");
    for (const location of [bin, config, jobTmp]) mkdirSync(location);
    const valid = path.join(config, "valid.yaml");
    const tampered = path.join(config, "tampered.yaml");
    const mounted = path.join(config, "route-extension.yaml");
    const captured = path.join(dir, "imported.yaml");
    writeFileSync(valid, document);
    writeFileSync(tampered, document.replace('celExpression: "true"', 'celExpression: "false"'));
    symlinkSync(swap === "after-expansion" ? tampered : valid, mounted);

    writeFileSync(
      path.join(bin, "awk"),
      `#!/bin/sh
/usr/bin/awk "$@"
if [ "$PROJECTION_SWAP" = after-expansion ]; then
  ln -s "$VALID_DOCUMENT" "$CONFIG_DOCUMENT.next"
  mv -f "$CONFIG_DOCUMENT.next" "$CONFIG_DOCUMENT"
fi
`,
      { mode: 0o700 },
    );
    writeFileSync(
      path.join(bin, "sha256sum"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const digest = require("node:crypto").createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex");
process.stdout.write(digest + "  " + process.argv[2] + "\\n");
if (process.env.PROJECTION_SWAP === "after-verification") {
  fs.symlinkSync(process.env.TAMPERED_DOCUMENT, process.env.CONFIG_DOCUMENT + ".next");
  fs.renameSync(process.env.CONFIG_DOCUMENT + ".next", process.env.CONFIG_DOCUMENT);
}
`,
      { mode: 0o700 },
    );
    writeFileSync(
      path.join(bin, "gcloud"),
      `#!/bin/sh
case "$1 $2 $3" in
  "service-extensions lb-traffic-extensions import") ;;
  *) exit 99 ;;
esac
for argument in "$@"; do
  case "$argument" in --source=*) cp "\${argument#--source=}" "$CAPTURE_FILE" ;; esac
done
`,
      { mode: 0o700 },
    );

    const job = renderRouteExtUpdateJob({
      releaseName: "my-app",
      projectId: "p-123456",
      buildId: "snapshot-test",
      documentDigest: createHash("sha256").update(document).digest("hex"),
    });
    const registration = job.slice(
      job.indexOf("              # 3. Register"),
      job.indexOf("          env:"),
    );
    expect(registration).toContain("lb-traffic-extensions import");
    const script =
      "set -e\n" +
      registration
        .replace(/^ {14}/gm, "")
        .replaceAll("/tmp/", jobTmp + "/")
        .replaceAll("/config/", config + "/")
        .replaceAll("{{ .Release.Namespace }}", "default");
    const result = spawnSync("/bin/sh", ["-c", script], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        PATH: bin + path.delimiter + process.env.PATH,
        FRS: "https://www.googleapis.com/compute/v1/projects/p-123456/global/forwardingRules/my-app-https",
        PROJECTION_SWAP: swap,
        VALID_DOCUMENT: valid,
        TAMPERED_DOCUMENT: tampered,
        CONFIG_DOCUMENT: mounted,
        CAPTURE_FILE: captured,
      },
    });
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      imported: existsSync(captured) ? readFileSync(captured, "utf8") : undefined,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("route-extension registration snapshot", () => {
  it("imports the verified document with discovered forwarding rules", () => {
    const result = register("none");
    expect(result.status, result.output).toBe(0);
    expect(result.imported).toContain('celExpression: "true"');
    expect(result.imported).toContain("/forwardingRules/my-app-https");
    expect(result.imported).not.toContain("FORWARDING_RULE_PLACEHOLDER");
  });

  it("rejects tampered bytes even if the legitimate projection returns after expansion", () => {
    const result = register("after-expansion");
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("does not match the rendered chart");
    expect(result.imported).toBeUndefined();
  });

  it("keeps using verified bytes when the projection changes after verification", () => {
    const result = register("after-verification");
    expect(result.status, result.output).toBe(0);
    expect(result.imported).toContain('celExpression: "true"');
    expect(result.imported).not.toContain('celExpression: "false"');
  });
});

it.each([
  {
    scenario: "unchanged",
    health: "HTTP,8081,/readyz,5,5,2,2",
    backend: "my-app-routing-ready-hc,60",
    mutations: [],
  },
  {
    scenario: "legacy TCP backend",
    health: "missing",
    backend: "my-app-routing-hc,0",
    mutations: ["health-checks create", "backend-services update"],
  },
  {
    scenario: "configuration drift",
    health: "HTTP,8081,/healthz,10,5,2,2",
    backend: "my-app-routing-ready-hc,0",
    mutations: ["health-checks update", "backend-services update"],
  },
  {
    scenario: "permission denied",
    health: "denied",
    backend: "my-app-routing-hc,0",
    mutations: ["health-checks create"],
  },
])("reconciles routing drain configuration: $scenario", ({ health, backend, mutations }) => {
  const dir = mkdtempSync(path.join(tmpdir(), "routing-drain-config-"));
  try {
    const log = path.join(dir, "calls.jsonl");
    writeFileSync(
      path.join(dir, "gcloud"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args[1] === 'health-checks') {
  if (process.env.HEALTH_STATE === 'denied') process.exit(1);
  if (args[2] === 'describe') {
    if (process.env.HEALTH_STATE === 'missing') process.exit(1);
    console.log(process.env.HEALTH_STATE);
  }
}
if (args[1] === 'backend-services' && args[2] === 'describe') console.log(process.env.BACKEND_STATE);
`,
      { mode: 0o700 },
    );
    const job = renderRouteExtUpdateJob({
      releaseName: "my-app",
      projectId: "p-123456",
      buildId: "drain",
    });
    const script = job
      .slice(job.indexOf("              set -e"), job.indexOf("              # 1. Discover"))
      .replace(/^ {14}/gm, "");
    const result = spawnSync("/bin/sh", ["-c", script], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        PATH: dir + path.delimiter + process.env.PATH,
        CALL_LOG: log,
        HEALTH_STATE: health,
        BACKEND_STATE: backend,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(health === "denied" ? 1 : 0);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(
      calls.filter((args) => args[2] !== "describe").map((args) => `${args[1]} ${args[2]}`),
    ).toEqual(mutations);
    expect(calls.some((args) => args[1] === "backend-services")).toBe(health !== "denied");
    const backendUpdate = calls.find(
      (args) => args[1] === "backend-services" && args[2] === "update",
    );
    if (backendUpdate) {
      expect(backendUpdate).toContain("--health-checks=my-app-routing-ready-hc");
      expect(backendUpdate).toContain("--connection-draining-timeout=60");
    }
    expect(calls.some((args) => args[2] === "delete")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
