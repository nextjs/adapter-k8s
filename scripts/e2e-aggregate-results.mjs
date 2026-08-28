#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runDirArg = process.argv[2];
if (!runDirArg) {
  console.error("Usage: e2e-aggregate-results.mjs <run-dir>");
  process.exit(2);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const adapterDir = path.resolve(scriptDir, "..");
const nextDir = process.env.NEXTJS_DIR
  ? path.resolve(process.env.NEXTJS_DIR)
  : path.resolve(adapterDir, "../.adapter-k8s-e2e/next.js");
const runDir = path.resolve(runDirArg);
const runStartPath = path.join(runDir, ".run-start");
const testDir = path.join(nextDir, "test");

if (!fs.existsSync(runStartPath)) {
  console.error(`Missing e2e run marker: ${runStartPath}`);
  process.exit(1);
}
if (!fs.existsSync(testDir)) {
  console.error(`Configured Next.js checkout has no test directory: ${testDir}`);
  process.exit(1);
}

const runStartMs = fs.statSync(runStartPath).mtimeMs;
const resultFiles = [];
const pendingDirs = [testDir];
while (pendingDirs.length > 0) {
  const currentDir = pendingDirs.pop();
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      pendingDirs.push(entryPath);
    } else if (entry.isFile() && entry.name.endsWith(".results.json")) {
      if (fs.statSync(entryPath).mtimeMs >= runStartMs) resultFiles.push(entryPath);
    }
  }
}

if (resultFiles.length === 0) {
  console.error(
    `No e2e result files at or after ${runStartPath} in configured checkout ${nextDir}`,
  );
  process.exit(1);
}

let tests = 0;
let passed = 0;
let failed = 0;
let passedOnRetry = 0;
const failedSuites = [];

for (const resultFile of resultFiles) {
  let result;
  try {
    result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  } catch (error) {
    console.error(`Invalid e2e result JSON ${resultFile}: ${error.message}`);
    process.exit(1);
  }

  const totalForSuite = result.numTotalTests ?? 0;
  const failedForSuite = result.numFailedTests ?? 0;
  tests += totalForSuite;
  passed += result.numPassedTests ?? 0;
  failed += failedForSuite;

  for (const testResult of result.testResults ?? []) {
    for (const assertion of testResult.assertionResults ?? []) {
      if (assertion.status === "passed" && (assertion.invocations ?? 1) > 1) {
        passedOnRetry += 1;
      }
    }
  }

  if (failedForSuite > 0) {
    failedSuites.push(`${path.relative(nextDir, resultFile)} (${failedForSuite}/${totalForSuite})`);
  }
}

console.log(
  `suites=${resultFiles.length} tests=${tests} passed=${passed} failed=${failed} ` +
    `passed_on_retry=${passedOnRetry}`,
);
for (const failedSuite of failedSuites.sort()) console.log(`  FAIL: ${failedSuite}`);
