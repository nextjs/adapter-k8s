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
TEST_RETRIES="${NEXT_TEST_RETRIES:-0}"
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

# --- 4. Build adapter ---
echo "Building adapter..."
cd "$ADAPTER_DIR"
npm run build

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
export NEXT_E2E_TEST_TIMEOUT=240000
export NEXT_EXTERNAL_TESTS_FILTERS="$NEXT_TEST_FILTERS"
export ADAPTER_DIR="$ADAPTER_DIR"
export IS_TURBOPACK_TEST=1
export NEXT_TEST_JOB=1
export NEXT_TELEMETRY_DISABLED=1
export NEXT_TEST_DEPLOY_SCRIPT_PATH="${ADAPTER_DIR}/scripts/e2e-deploy.sh"
export NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH="${ADAPTER_DIR}/scripts/e2e-logs.sh"
export NEXT_TEST_CLEANUP_SCRIPT_PATH="${ADAPTER_DIR}/scripts/e2e-cleanup.sh"

CONCURRENCY="${NEXT_TEST_CONCURRENCY:-1}"

if [ -n "$TEST_PATTERN" ]; then
  node run-tests.js --test-pattern "$TEST_PATTERN" --retries "$TEST_RETRIES" -c "$CONCURRENCY" --debug
else
  node run-tests.js --timings -g "$TEST_GROUP" --retries "$TEST_RETRIES" -c "$CONCURRENCY" --type e2e
fi
