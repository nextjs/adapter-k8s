// Work out which environment variables the upstream harness injected for a suite, so the
// cluster deploy can forward exactly those into the pod and nothing else.
//
// Why a diff rather than an allowlist: `nextTestSetup({ env: {...} })` values arrive merged
// into the deploy script's whole process environment (test/lib/next-modes/next-deploy.ts
// spreads `...this.env` over `...process.env`), so by the time we see them they are
// indistinguishable from ambient ones. Forwarding everything would push PATH, HOME, and any
// cloud credentials on the box into a container image's pod spec. Diffing against a snapshot
// taken BEFORE run-tests.js starts isolates precisely what the harness added.
//
// 62 of 1,051 e2e suites declare `env`, including app-dir/app-static.

/** Names the run wrapper and the shared setup add themselves — never the suite's. */
const DENY_EXACT = new Set([
  "NEXT_TEST_DIR",
  "NEXT_ADAPTER_PATH",
  "NEXT_PRIVATE_TEST_MODE",
  "NEXT_DEPLOYMENT_ID",
  "NEXT_TELEMETRY_DISABLED",
  "NEXT_ENABLE_ADAPTER",
  "NEXT_E2E_TEST_TIMEOUT",
  "NEXT_EXTERNAL_TESTS_FILTERS",
  "IS_TURBOPACK_TEST",
  "ADAPTER_DIR",
  "BUILD_CPUS",
  "BUILD_MAX_OLD_SPACE_MB",
  "NODE_OPTIONS",
  "PORT",
]);

/**
 * Added by run-tests.js and jest AFTER the wrapper takes its snapshot, so the diff cannot
 * tell them from a suite's own declarations. This is a CLOSED set — the runner's and jest's
 * documented variables plus the usual CI conventions — not an open-ended list of whatever
 * turned up. Observed in full on the 2026-07-29 acceptance run.
 *
 * NODE_PATH is the one that actually matters: a host path injected into a container changes
 * module resolution for the pool server. The CI trio matters because a fixture is entitled to
 * branch on it, which would make the container behave unlike the app under test.
 */
const DENY_RUNNER = new Set([
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "CIRCLECI",
  "BUILD_NUMBER",
  "RUN_ID",
  "NODE_PATH",
  "TEST_FILE_PATH",
  "HEADLESS",
  "TRACE_PLAYWRIGHT",
  "RUST_MIN_STACK",
  "UPSTASH_DISABLE_TELEMETRY",
  "_",
]);

const DENY_PREFIX = ["NEXT_TEST_", "ADAPTER_K8S_", "__NEXT_", "npm_", "JEST_"];

/**
 * Names the adapter itself emits into every pool container. Forwarding one would be rejected
 * by validateConfig (correctly), failing the whole deploy over a variable the suite did not
 * ask for — so drop them here instead, and say so.
 */
const RESERVED = new Set([
  "NODE_ENV",
  "NEXT_BUILD_ID",
  "POOL_NAME",
  "RELEASE_NAME",
  "INTERNAL_HEADER_SECRET",
  "VALKEY_URL",
  "VALKEY_AUTH",
  "VALKEY_CA_CERT",
  "CONFIG_DIR",
]);

const VALID_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * A suite declares a handful of variables — the largest in the tree declares three. Anything
 * near this many means the baseline is missing or stale, and the "diff" has degenerated into
 * "forward the whole shell": PATH, XDG_*, credentials, the lot, into a pod spec. Measured
 * during development with a deliberately truncated baseline: 80 variables, including the
 * session's own tooling env. Fail loudly rather than ship that.
 */
export const MAX_FORWARDED = 32;

/**
 * @param {Record<string,string|undefined>} current  the deploy script's environment
 * @param {string[]} baseline  variable names present before the harness ran
 * @returns {{ env: Record<string,string>, skipped: string[] }}
 */
export function harnessInjectedEnv(current, baseline) {
  const before = new Set(baseline);
  const env = {};
  const skipped = [];
  for (const [name, value] of Object.entries(current)) {
    if (before.has(name) || value === undefined) continue;
    if (DENY_EXACT.has(name) || DENY_RUNNER.has(name)) continue;
    if (DENY_PREFIX.some((p) => name.startsWith(p))) continue;
    if (!VALID_NAME.test(name)) {
      skipped.push(`${name} (invalid name)`);
      continue;
    }
    if (RESERVED.has(name)) {
      skipped.push(`${name} (reserved by the adapter)`);
      continue;
    }
    if (name.startsWith("NEXT_PUBLIC_")) {
      // Correct to drop: these are inlined into client bundles at BUILD time, and the build
      // already saw them via the deploy script's own environment. As pod env they would do
      // nothing, and validateConfig rejects them for exactly that reason.
      skipped.push(`${name} (NEXT_PUBLIC_, applied at build time instead)`);
      continue;
    }
    env[name] = value;
  }
  const names = Object.keys(env);
  if (names.length > MAX_FORWARDED) {
    throw new Error(
      `Refusing to forward ${names.length} environment variables into the pod (limit ` +
        `${MAX_FORWARDED}). The baseline snapshot is almost certainly missing or stale, which ` +
        `turns this diff into a dump of the build host's entire environment — credentials ` +
        `included. Check ADAPTER_K8S_E2E_ENV_SNAPSHOT. First few: ${names.slice(0, 8).join(", ")}`,
    );
  }
  return { env, skipped };
}

// CLI: `node e2e-cluster-env.mjs <snapshot-file>` → JSON of forwarded vars on stdout,
// diagnostics on stderr (the deploy script's stdout is reserved for the deployment URL).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ""))) {
  const { readFileSync } = await import("node:fs");
  const snapshotPath = process.argv[2];
  const baseline = snapshotPath
    ? readFileSync(snapshotPath, "utf8").split("\n").filter(Boolean)
    : [];
  const { env, skipped } = harnessInjectedEnv(process.env, baseline);
  const names = Object.keys(env);
  process.stderr.write(
    names.length > 0
      ? `[adapter-k8s] Forwarding suite env to the pod: ${names.join(", ")}\n`
      : "[adapter-k8s] No suite-declared env to forward\n",
  );
  if (skipped.length > 0) {
    process.stderr.write(`[adapter-k8s] Not forwarded: ${skipped.join(", ")}\n`);
  }
  process.stdout.write(JSON.stringify(env));
}
