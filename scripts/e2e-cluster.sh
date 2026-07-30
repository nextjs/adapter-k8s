#!/usr/bin/env bash
set -euo pipefail

# Run an upstream Next.js e2e suite against a REAL CLUSTER (Phase 3 topology).
#
# Usage:
#   ./scripts/e2e-cluster.sh <test-pattern> [nextjs-ref]
#
# Examples:
#   ./scripts/e2e-cluster.sh "test/e2e/middleware-responses/index.test.ts"
#   ./scripts/e2e-cluster.sh "middleware-general" v16.3.0-canary.97
#
# A test pattern is REQUIRED. There is no "just run everything" form on purpose: every
# suite here is a full build + image push + blue/green rollout against shared cloud
# infrastructure, so an accidental bare invocation is expensive in both money and time.
# The large run gets its own deliberate driver.
#
# WHAT THIS CLOBBERS: the target release currently serves the repo's resident fixture
# app. Each suite replaces it. Restore afterwards by deploying fixtures/main again:
#   (cd fixtures/main && npx adapter-k8s deploy)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TEST_PATTERN="${1:-}"
NEXTJS_REF="${2:-v16.3.0-canary.97}"

if [ -z "$TEST_PATTERN" ]; then
  echo "ERROR: a test pattern is required (see the header of this script)." >&2
  exit 1
fi

# Source of truth for the deploy target. Seeded from the resident fixture app, then kept
# separate so the run's state.json churn does not overwrite the fixture's own.
CLUSTER_STATE_DIR="${ADAPTER_K8S_E2E_CLUSTER_STATE:-${ADAPTER_DIR}/.k8s-adapter/e2e-cluster}"
SEED_DIR="${ADAPTER_K8S_E2E_CLUSTER_SEED:-${ADAPTER_DIR}/fixtures/main}"

if [ ! -d "${CLUSTER_STATE_DIR}/.k8s-adapter" ]; then
  echo "Seeding cluster state from ${SEED_DIR}..."
  mkdir -p "${CLUSTER_STATE_DIR}/.k8s-adapter"
  cp "${SEED_DIR}/adapter.config.mjs" "${CLUSTER_STATE_DIR}/adapter.config.mjs"
  cp "${SEED_DIR}/.k8s-adapter/infrastructure.json" "${CLUSTER_STATE_DIR}/.k8s-adapter/"
  for optional in internal-secret.key state.json; do
    [ -f "${SEED_DIR}/.k8s-adapter/${optional}" ] &&
      cp "${SEED_DIR}/.k8s-adapter/${optional}" "${CLUSTER_STATE_DIR}/.k8s-adapter/"
  done
  chmod 600 "${CLUSTER_STATE_DIR}/.k8s-adapter/internal-secret.key" 2>/dev/null || true
fi

RELEASE="$(node -e "
  process.stdout.write(require('${CLUSTER_STATE_DIR}/.k8s-adapter/infrastructure.json').releaseName)
")"
HOST="$(node -e "
  process.stdout.write(require('${CLUSTER_STATE_DIR}/.k8s-adapter/infrastructure.json').hosts[0])
")"

echo "=== Adapter K8s E2E — CLUSTER topology ==="
echo "Release:   ${RELEASE}"
echo "Host:      https://${HOST}"
echo "State:     ${CLUSTER_STATE_DIR}"
echo "Context:   $(kubectl config current-context)"
echo "Test:      ${TEST_PATTERN}"
echo ""

# Snapshot the environment BEFORE run-tests.js starts. The deploy script diffs against this
# to recover exactly the variables a suite declared via `nextTestSetup({ env })` — the harness
# merges them into the whole process environment, so without a baseline they are
# indistinguishable from the build host's own (including its cloud credentials).
ENV_SNAPSHOT="${CLUSTER_STATE_DIR}/.env-baseline"
compgen -e | sort > "$ENV_SNAPSHOT"
export ADAPTER_K8S_E2E_ENV_SNAPSHOT="$ENV_SNAPSHOT"

export ADAPTER_K8S_E2E_CLUSTER_STATE="$CLUSTER_STATE_DIR"
export ADAPTER_K8S_E2E_RELEASE="$RELEASE"
export NEXT_TEST_DEPLOY_SCRIPT_PATH="${ADAPTER_DIR}/scripts/e2e-cluster-deploy.sh"
export NEXT_TEST_CLEANUP_SCRIPT_PATH="${ADAPTER_DIR}/scripts/e2e-cluster-cleanup.sh"

# Serial, always. See the header of e2e-cluster-deploy.sh: concurrent deploys race the
# same blue/green cutover on one hostname and each serves the other's app.
export NEXT_TEST_CONCURRENCY=1

# A cluster deploy is minutes, not seconds, and the harness's timeout covers deploy +
# test. The pool topology's 240s would expire during the image push.
export NEXT_E2E_TEST_TIMEOUT="${NEXT_E2E_TEST_TIMEOUT:-1800000}"

# No retries by default. A retry here means another full build/push/rollout, and the
# question this topology exists to answer — "is the failure real?" — is exactly the one
# a retry obscures.
export NEXT_TEST_RETRIES="${NEXT_TEST_RETRIES:-0}"

chmod +x "${ADAPTER_DIR}/scripts/e2e-cluster-deploy.sh" "${ADAPTER_DIR}/scripts/e2e-cluster-cleanup.sh"

exec bash "${SCRIPT_DIR}/e2e-local.sh" "$TEST_PATTERN" "$NEXTJS_REF"
