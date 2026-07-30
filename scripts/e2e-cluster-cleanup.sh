#!/usr/bin/env bash
set -euo pipefail

# Cleanup for the PHASE 3 (real cluster) topology.
#
# Deliberately does NOT tear the release down. Every suite deploys to the same release,
# and the next one's blue/green cutover replaces this build — destroying it here would
# mean re-provisioning gateway/IP/cert per suite, which costs more than the whole run.
# Restoring the cluster to the resident fixture app is the RUN's job (e2e-cluster.sh),
# not the per-suite job.
#
# What is worth doing per suite is capturing pod-side evidence while it still exists:
# the next deploy's cutover will scale these pods away.

RELEASE="${ADAPTER_K8S_E2E_RELEASE:-}"
if [ -z "$RELEASE" ] && [ -f ".k8s-adapter/infrastructure.json" ]; then
  RELEASE="$(node -e "
    try { process.stdout.write(require('./.k8s-adapter/infrastructure.json').releaseName ?? '') }
    catch { }
  " 2>/dev/null || true)"
fi

if [ -n "$RELEASE" ] && command -v kubectl >/dev/null 2>&1; then
  echo "=== Pool pod tail (release ${RELEASE}) ==="
  kubectl logs -l "app.kubernetes.io/instance=${RELEASE}" \
    --all-containers --tail=40 --since=15m 2>&1 | tail -80 || true
fi

if [ -f ".adapter-deploy.log" ]; then
  PERSIST_PATH="${ADAPTER_K8S_PERSIST_SERVER_LOG:-/tmp/adapter-k8s-last-cluster-deploy.log}"
  cp .adapter-deploy.log "$PERSIST_PATH" 2>/dev/null || true
fi
