#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE="${ADAPTER_DIR}/../.adapter-k8s-e2e-firebase"
NEXTJS_DIR="${NEXTJS_DIR:-${WORKSPACE}/next.js}"
TEST_PATTERN="${1:-}"
NEXTJS_REF="${2:-canary}"
TEST_RETRIES="${NEXT_TEST_RETRIES:-0}"
BASELINE_MANIFEST="${ADAPTER_DIR}/test/deploy-tests-manifest.firebase-baseline.json"
NEXT_TEST_FILTERS="test/deploy-tests-manifest.json,${BASELINE_MANIFEST}"

echo "=== Firebase CLI Baseline E2E Runner ==="
echo "Firebase tools baseline: firebase-tools@${FIREBASE_TOOLS_BASELINE_VERSION:-latest}"
echo "Workspace: ${WORKSPACE}"
echo "Next.js:  ${NEXTJS_DIR} (ref: ${NEXTJS_REF})"
echo "Test:     ${TEST_PATTERN:-filtered deploy suite}"
echo "Retries:  ${TEST_RETRIES}"
echo ""

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

echo "Building Next.js..."
cd "$NEXTJS_DIR"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable
fi
pnpm install
pnpm build
pnpm install

echo "Installing Playwright..."
pnpm playwright install chromium

cd "$ADAPTER_DIR"
chmod +x scripts/e2e-baseline-firebase-deploy.sh scripts/e2e-logs.sh scripts/e2e-cleanup.sh

echo ""
echo "Running tests..."
cd "$NEXTJS_DIR"

export NEXT_TEST_MODE=deploy
export NEXT_E2E_TEST_TIMEOUT=240000
export NEXT_EXTERNAL_TESTS_FILTERS="$NEXT_TEST_FILTERS"
export ADAPTER_DIR="$ADAPTER_DIR"
export IS_TURBOPACK_TEST=1
export NEXT_TEST_JOB=1
export NEXT_TELEMETRY_DISABLED=1
export NEXT_TEST_DEPLOY_SCRIPT_PATH="${ADAPTER_DIR}/scripts/e2e-baseline-firebase-deploy.sh"
export NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH="${ADAPTER_DIR}/scripts/e2e-logs.sh"
export NEXT_TEST_CLEANUP_SCRIPT_PATH="${ADAPTER_DIR}/scripts/e2e-cleanup.sh"

if [ -n "$TEST_PATTERN" ]; then
  node run-tests.js --test-pattern "$TEST_PATTERN" --retries "$TEST_RETRIES" -c 1 --debug
else
  node run-tests.js --timings -g 1/1 --retries "$TEST_RETRIES" -c 1 --type e2e
fi
