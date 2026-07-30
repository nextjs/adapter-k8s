#!/usr/bin/env bash
set -euo pipefail

# PHASE 2: run an upstream Next.js e2e suite against the LOCAL k3d cluster — the real
# production topology (Envoy Gateway → ext_proc routing service → pools, generic provider)
# with none of the cloud: local registry (image push is a disk copy), Host-routed hostnames
# on a mapped port, in-cluster Valkey. This is the successor to the retired process-level
# Envoy emulation; it reuses the ENTIRE cluster harness (e2e-cluster.sh and friends) and
# differs only in target.
#
# Usage:
#   ./scripts/e2e-local-cluster.sh <test-pattern> [nextjs-ref]
#
# Prereq (once): ./scripts/e2e-k3d-bootstrap.sh
#
# ISOLATION: everything kubectl goes through the bootstrap's dedicated kubeconfig. The
# global kubectl context is never read or written, so cloud work in another terminal cannot
# be cross-wired (measured failure mode, 2026-07-30 — see e2e-k3d-bootstrap.sh).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TEST_PATTERN="${1:-}"
NEXTJS_REF="${2:-v16.3.0-canary.97}"
TEST_GROUP="${3:-}"
if [ -z "$TEST_PATTERN" ] && [ -z "$TEST_GROUP" ]; then
  echo "ERROR: a test pattern (arg 1) or group (arg 3) is required." >&2
  exit 1
fi

# LANE mode: E2E_LANE=N gives this run its own release, hostname, and state dir, so N lanes
# deploy concurrently to one cluster with zero shared mutable state (the cutover lock is
# per-state-dir). All lanes share the merged Envoy data plane (Host routing) and Valkey
# (build-id-namespaced keys).
if [ -n "${E2E_LANE:-}" ]; then
  E2E_K3D_RELEASE="e2e-lane${E2E_LANE}"
  E2E_K3D_HOSTNAME="lane${E2E_LANE}.localhost"
  ADAPTER_K8S_E2E_CLUSTER_STATE="${ADAPTER_DIR}/.k8s-adapter/e2e-lane${E2E_LANE}"
fi

export KUBECONFIG="${E2E_K3D_KUBECONFIG:-$HOME/.kube/k3d-adapter-e2e.yaml}"
if [ ! -f "$KUBECONFIG" ]; then
  echo "ERROR: ${KUBECONFIG} not found — run scripts/e2e-k3d-bootstrap.sh first." >&2
  exit 1
fi

HTTP_PORT="${E2E_K3D_HTTP_PORT:-8788}"
REGISTRY_PORT="${E2E_K3D_REGISTRY_PORT:-5511}"
HOSTNAME_LOCAL="${E2E_K3D_HOSTNAME:-e2e.localhost}"
RELEASE="${E2E_K3D_RELEASE:-e2e-local}"

# --- Seed the deploy-target state (once) ---
STATE_DIR="${ADAPTER_K8S_E2E_CLUSTER_STATE:-${ADAPTER_DIR}/.k8s-adapter/e2e-local}"
if [ ! -f "${STATE_DIR}/adapter.config.mjs" ]; then
  echo "Seeding local-cluster deploy target at ${STATE_DIR}..."
  mkdir -p "${STATE_DIR}/.k8s-adapter"
  cat > "${STATE_DIR}/adapter.config.mjs" <<EOF
import { createK8sAdapter } from "@next-community/adapter-k8s";

// PHASE 2 target: generic provider on the local k3d cluster (see e2e-k3d-bootstrap.sh).
// Cache ENABLED via the in-cluster Valkey — the production cache lifecycle (seed fallback,
// shared incremental cache, tag invalidation) is part of what this topology exists to test.
export default createK8sAdapter({
  pools: {
    default: {
      routes: ["appPages", "appRoutes", "pages", "pagesApi"],
      scaling: { min: 2, max: 2, targetCPU: 70 },
    },
  },
  cache: { enabled: true, url: "redis://e2e-valkey.default.svc.cluster.local:6379" },
  containerStrategy: "traced-assets",
  provider: {
    generic: {
      gateway: {
        className: "eg",
        hosts: [{ hostname: "${HOSTNAME_LOCAL}", tls: { enabled: false } }],
      },
    },
  },
});
EOF
  cat > "${STATE_DIR}/.k8s-adapter/infrastructure.json" <<EOF
{
  "releaseName": "${RELEASE}",
  "containerRegistry": "localhost:${REGISTRY_PORT}/adapter-e2e",
  "hosts": ["${HOSTNAME_LOCAL}"]
}
EOF
  # Operator key for the per-build dispatch secret derivation. Local-only; 0600.
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" \
    > "${STATE_DIR}/.k8s-adapter/internal-secret.key"
  chmod 600 "${STATE_DIR}/.k8s-adapter/internal-secret.key"
fi

# The public path for the stability gate and the harness URL: plain HTTP on the mapped port.
export ADAPTER_K8S_E2E_BASE_URL="http://${HOSTNAME_LOCAL}:${HTTP_PORT}"
export ADAPTER_K8S_E2E_CLUSTER_STATE="$STATE_DIR"

exec bash "${SCRIPT_DIR}/e2e-cluster.sh" "$TEST_PATTERN" "$NEXTJS_REF" "$TEST_GROUP"
