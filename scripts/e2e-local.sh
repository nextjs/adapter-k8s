#!/usr/bin/env bash
set -euo pipefail

# Run a Next.js e2e deploy test locally.
#
# Usage:
#   ./scripts/e2e-local.sh [test-pattern] [nextjs-ref]
#
# Examples:
#   ./scripts/e2e-local.sh
#   ./scripts/e2e-local.sh "test/e2e/app-dir/app/index.test.ts"
#   ./scripts/e2e-local.sh "app-dir/app-static" canary

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Keep the Next.js checkout outside the adapter repo so npm/package-lock.json
# here cannot influence workspace or bundler root detection in the Next.js repo.
WORKSPACE="${ADAPTER_DIR}/../.adapter-k8s-e2e"
NEXTJS_DIR="${NEXTJS_DIR:-${WORKSPACE}/next.js}"
TEST_PATTERN="${1:-}"
NEXTJS_REF="${2:-canary}"
TEST_GROUP="${3:-1/1}"
# Match upstream CI (.github/workflows/integration_tests_reusable.yml `num_retries: 2`) so
# our pass/fail numbers are comparable to Next's own. This was 0 while the adapter still had
# ~1000 failures — retrying a wall of real failures only burned wall-clock. Now that the
# residual count is small, retries filter deploy-casualty and browser-timing flake instead.
# CAVEAT: retries also MASK genuinely intermittent failures (upstream's own
# cache-components-allow-otel-spans TODO notes its failure "is masked in CI because of the
# built-in jest retry"). When comparing runs, grep the run log for `finished on retry [1-9]`
# to see what only passed on a retry, and use `--retries 0` when hunting a specific flake.
TEST_RETRIES="${NEXT_TEST_RETRIES:-2}"
# 4 is the measured sweet spot for this class of machine, and the concurrency of every
# recorded baseline run. 1 (the old default) turns a ~17-minute full run into ~10 hours;
# 16 was measured (2026-07-28) to produce ~205 CONTENTION failures — images decoding to
# naturalWidth=0, `_next/image` 503s, Playwright websocket ECONNREFUSED — concentrated in
# browser-heavy suites. If you change this, re-derive the failure baseline first.
CONCURRENCY="${NEXT_TEST_CONCURRENCY:-4}"
ADAPTER_MANIFEST="${ADAPTER_DIR}/test/deploy-tests-manifest.adapter-k8s.json"
NEXT_TEST_FILTERS="test/deploy-tests-manifest.json"

if [ -f "$ADAPTER_MANIFEST" ]; then
  NEXT_TEST_FILTERS="${NEXT_TEST_FILTERS},${ADAPTER_MANIFEST}"
fi

echo "=== Next.js Adapter K8s E2E Test Runner ==="
echo "Adapter:  ${ADAPTER_DIR}"
echo "Workspace: ${WORKSPACE}"
echo "Next.js:  ${NEXTJS_DIR} (ref: ${NEXTJS_REF})"
echo "Test:     ${TEST_PATTERN:-filtered deploy suite}"
echo "Group:    ${TEST_GROUP}"
echo "Retries:  ${TEST_RETRIES}"
echo "Concurrency: ${CONCURRENCY}"
echo ""

# --- 1. Clone/fetch Next.js ---
if [ -d "$NEXTJS_DIR/.git" ]; then
  echo "Fetching Next.js ref ${NEXTJS_REF}..."
  cd "$NEXTJS_DIR"
  git fetch origin "$NEXTJS_REF" --depth=25
  git checkout FETCH_HEAD
else
  echo "Cloning Next.js..."
  mkdir -p "$WORKSPACE"
  git clone --depth=25 --branch "$NEXTJS_REF" https://github.com/vercel/next.js.git "$NEXTJS_DIR"
fi

# --- 2. Build Next.js ---
echo "Building Next.js..."
cd "$NEXTJS_DIR"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable
fi
pnpm install
pnpm build
pnpm install

# --- 3. Install Playwright ---
echo "Installing Playwright..."
pnpm playwright install chromium

# --- 4. Build + pack the adapter ONCE for the whole run ---
# Every deploy then installs this exact tarball (the ADAPTER_K8S_PREBUILT_TARBALL fast
# path in e2e-deploy.sh). Without it, EVERY deploy rebuilds + repacks the adapter behind
# a serializing lock — the "why is the suite taking hours" footgun. A caller-provided
# tarball is respected and the build skipped (that is how to A/B a specific artifact).
if [ -z "${ADAPTER_K8S_PREBUILT_TARBALL:-}" ]; then
  echo "Building adapter..."
  cd "$ADAPTER_DIR"
  npm run build
  RUN_PACK_DIR="$(mktemp -d /tmp/adapter-k8s-run-pack-XXXXXX)"
  trap 'rm -rf "$RUN_PACK_DIR"' EXIT
  PACK_JSON="$(npm pack --json --ignore-scripts --pack-destination "$RUN_PACK_DIR")"
  ADAPTER_K8S_PREBUILT_TARBALL="$RUN_PACK_DIR/$(
    node -e "console.log(JSON.parse(process.argv[1])[0].filename)" "$PACK_JSON"
  )"
fi
export ADAPTER_K8S_PREBUILT_TARBALL
echo "Adapter tarball (packed once, reused by every deploy): ${ADAPTER_K8S_PREBUILT_TARBALL}"
cd "$ADAPTER_DIR"

# --- 5. Make scripts executable ---
chmod +x scripts/e2e-deploy.sh scripts/e2e-logs.sh scripts/e2e-cleanup.sh

# --- 6. Run tests ---
echo ""
echo "Running tests..."
cd "$NEXTJS_DIR"

export NEXT_TEST_MODE=deploy
# Identify as an adapter run. Canary uses this to skip tests it disables for Turbopack adapters
# (e.g. middleware-rewrites via `skipDeployment: isAdapterTest && isTurbopackTest`), and the harness
# gates its immutable-assets reporting on it. Without it we wrongly run+fail upstream-disabled tests.
export NEXT_ENABLE_ADAPTER=1
# Covers deploy + test, since createNext() runs inside the suite's beforeAll hook. 240s is
# right for a local pool start; a real-cluster deploy (image push + rollout + LB program)
# blows through it, and the failure looks like "14 tests failed" rather than "the deploy
# was still running". Overridable so the cluster topology can raise it.
export NEXT_E2E_TEST_TIMEOUT="${NEXT_E2E_TEST_TIMEOUT:-240000}"
export NEXT_EXTERNAL_TESTS_FILTERS="$NEXT_TEST_FILTERS"
export ADAPTER_DIR="$ADAPTER_DIR"
export IS_TURBOPACK_TEST=1
export NEXT_TEST_JOB=1
export NEXT_TELEMETRY_DISABLED=1
# Topology selection. These were assigned unconditionally, which silently defeated the
# only mechanism callers had to pick a different one: `npm run test:integration` sets
# NEXT_TEST_DEPLOY_SCRIPT_PATH=scripts/e2e-integration-deploy.sh and this line overwrote
# it, so the "Phase 2 through Envoy" suite was in fact running the Phase 1 pool topology.
# Defaulting instead of assigning keeps Phase 1 the default for a bare `test:e2e`.
export NEXT_TEST_DEPLOY_SCRIPT_PATH="${NEXT_TEST_DEPLOY_SCRIPT_PATH:-${ADAPTER_DIR}/scripts/e2e-deploy.sh}"
export NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH="${NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH:-${ADAPTER_DIR}/scripts/e2e-logs.sh}"
export NEXT_TEST_CLEANUP_SCRIPT_PATH="${NEXT_TEST_CLEANUP_SCRIPT_PATH:-${ADAPTER_DIR}/scripts/e2e-cleanup.sh}"
# Relative paths are how package.json spells these; the harness runs them from the
# Next.js checkout, where a relative path resolves to the wrong tree (or nothing).
for _var in NEXT_TEST_DEPLOY_SCRIPT_PATH NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH NEXT_TEST_CLEANUP_SCRIPT_PATH; do
  _val="${!_var}"
  case "$_val" in
    /*) ;;
    *) export "$_var=${ADAPTER_DIR}/${_val}" ;;
  esac
  [ -f "${!_var}" ] || { echo "ERROR: ${_var} does not exist: ${!_var}" >&2; exit 1; }
done
echo "Topology:  ${NEXT_TEST_DEPLOY_SCRIPT_PATH}"

if [ -n "$TEST_PATTERN" ]; then
  node run-tests.js --test-pattern "$TEST_PATTERN" --retries "$TEST_RETRIES" -c "$CONCURRENCY" --debug
else
  node run-tests.js --timings -g "$TEST_GROUP" --retries "$TEST_RETRIES" -c "$CONCURRENCY" --type e2e
fi
