#!/usr/bin/env bash
set -euo pipefail

# Next.js Adapter E2E Deploy Script — local pool-server topology.
#
# The harness points the suite straight at the pool, so requests take the pool's own
# local resolution path (middleware runs in-pool). The local k3d harness exercises the
# deployed Envoy Gateway, ext_proc routing service, pools, and cache topology.
#
# Shared setup (pack/install/build/config) lives in e2e-setup-common.sh so local and
# Kubernetes deploys cannot drift apart — see the note there.
#
# Contract (from nextjs.org/docs/.../adapterPath#testing-adapters):
# - cwd is set to the isolated test app by the harness
# - Exit non-zero on failure
# - Print deployment URL to stdout (nothing else)
# - Write diagnostics to stderr or files

# shellcheck source=./e2e-setup-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/e2e-setup-common.sh"

# --- 5. Start pool server ---
# Asking the pool itself to bind port zero leaves allocation and ownership in one atomic kernel
# operation. Reserving a port in a probe process first still left a close-to-listen window where an
# unrelated Next.js test process could claim it, even when adapter deploy lanes serialized.
PORT=0
export PORT POOL_NAME=default NEXT_BUILD_ID="${BUILD_ID}" CONFIG_DIR="$(pwd)/config" NODE_ENV=production

echo "[adapter-k8s] Starting on an ephemeral loopback port..." >&2
echo "[adapter-k8s] Pool server CJS at: ${POOL_SERVER_CJS_LOCAL}" >&2
echo "[adapter-k8s] CONFIG_DIR=${CONFIG_DIR}" >&2
ls config/ >&2
node "${POOL_SERVER_CJS_LOCAL}" > .adapter-server.log 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > .adapter-server.pid
echo "[adapter-k8s] Server PID: ${SERVER_PID}" >&2

# --- 6. Wait for ready ---
BOUND_PORT=""
for i in $(seq 1 60); do
  BOUND_PORT="$(sed -n 's/^Pool server listening on port \([0-9][0-9]*\)$/\1/p' .adapter-server.log | tail -n 1)"
  if [ -n "$BOUND_PORT" ] && node -e "const socket=require('net').createConnection(Number(process.argv[1]),'127.0.0.1');socket.on('connect',()=>{socket.destroy();process.exit(0)});socket.on('error',()=>process.exit(1));setTimeout(()=>{socket.destroy();process.exit(1)},400)" "$BOUND_PORT" 2>/dev/null; then
    PORT="$BOUND_PORT"
    export PORT
    echo "[adapter-k8s] Ready on :${PORT}" >&2
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "[adapter-k8s] TIMEOUT — server didn't start in 30s" >&2
    echo "=== Server log ===" >&2
    cat .adapter-server.log >&2
    echo "=== Config dir ===" >&2
    ls -la config/ >&2 2>&1
    echo "=== .k8s-adapter/output ===" >&2
    ls .k8s-adapter/output/ >&2 2>&1 || echo "(no output dir)" >&2
    exit 1
  fi
  kill -0 "$(cat .adapter-server.pid)" 2>/dev/null || {
    echo "[adapter-k8s] CRASHED" >&2
    cat .adapter-server.log >&2
    exit 1
  }
  sleep 0.5
done

# --- 7. URL on stdout ---
echo "http://127.0.0.1:${PORT}"
