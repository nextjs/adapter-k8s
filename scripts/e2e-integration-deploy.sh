#!/usr/bin/env bash
set -euo pipefail

# Next.js Adapter E2E Deploy Script — PHASE 2 topology (the full edge stack):
#
#   Envoy (:8080) -> Routing Service ext_proc (:8443) -> Pool Server (:3000)
#
# This is the path a real deployment takes: the routing service resolves routes and runs
# middleware at the edge, then forwards trusted dispatch headers (x-output-id,
# x-mw-evaluated, the internal secret) so the pool skips its own resolution. Phase 1
# (scripts/e2e-deploy.sh) never exercises any of that.
#
# Exercises: ext_proc header mutations, edge middleware execution, beforeFiles/afterFiles
# rewrite resolution, static-asset handling, and handler invocation via dispatch headers.
#
# FIXED PORTS, so run with -c 1. CI gets its parallelism from matrix runners instead;
# two concurrent test apps here would fight over 8080/8443/3000.
#
# Shared setup (pack/install/build/config) is sourced from e2e-setup-common.sh. It used to
# be a divergent copy that had rotted — see the note there.
#
# Contract (from nextjs.org/docs/.../adapterPath#testing-adapters):
# - cwd is set to the isolated test app by the harness
# - Exit non-zero on failure
# - Print deployment URL to stdout (nothing else)
# - Write diagnostics to stderr or files

# shellcheck source=./e2e-setup-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/e2e-setup-common.sh"

# --- 5. Start pool server (:3000 — the port integration/envoy.yaml routes to) ---
{
  export CONFIG_DIR="${PWD}/config"
  export POOL_NAME=default NEXT_BUILD_ID="${BUILD_ID}" NODE_ENV=production
  export PORT=3000
  echo "[adapter-k8s] Starting pool server on :3000..."
  node "${POOL_SERVER_CJS_LOCAL}" >> .adapter-server.log 2>&1 &
  POOL_PID=$!
  echo "${POOL_PID}" > .adapter-pool.pid
} >&2

# --- 4. Start Routing Service ---
{
  export PORT=8443
  # Same CONFIG_DIR the pool uses — the routing tier reads the routing manifest from it.
  export CONFIG_DIR="${PWD}/config"
  # The routing service refuses to start plaintext by default: GCP ext_proc callouts need
  # HTTP/2 over TLS, and a plaintext pod would look healthy while every callout failed.
  # integration/envoy.yaml dials :8443 with no transport_socket (h2c), exactly as `emulate`
  # does — so opt in here for the same reason emulate.ts does. LOCAL EMULATION ONLY.
  export ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT=1
  echo "[adapter-k8s] Starting routing service on :8443..."
  node "${ROUTING_SERVICE_CJS_LOCAL}" >> .adapter-routing.log 2>&1 &
  ROUTING_PID=$!
  echo "${ROUTING_PID}" > .adapter-routing.pid
} >&2

# --- 5. Start Envoy ---
{
  # The config path differs by launcher: a LOCAL binary reads the host path, the container
  # reads its bind-mount target. Hardcoding /etc/envoy/envoy.yaml for both made the local
  # branch die with "Invalid path" — that path only exists inside the container.
  #
  # `command -v envoy` is not enough either: `envoy` is also an SSH agent manager on some
  # distros. Real Envoy answers `--version` with "version:", the same check emulate.ts makes.
  ENVOY_CONFIG_HOST="${ADAPTER_DIR}/integration/envoy.yaml"
  if envoy --version 2>&1 | grep -q "version:"; then
    ENVOY_CMD="envoy"
    ENVOY_CONFIG_ARG="${ENVOY_CONFIG_HOST}"
  elif docker image inspect envoyproxy/envoy:v1.32-latest &>/dev/null 2>&1 || docker pull envoyproxy/envoy:v1.32-latest >&2 2>&1; then
    ENVOY_CMD="docker run --rm --network host -v ${ENVOY_CONFIG_HOST}:/etc/envoy/envoy.yaml:ro envoyproxy/envoy:v1.32-latest"
    ENVOY_CONFIG_ARG="/etc/envoy/envoy.yaml"
  else
    echo "[adapter-k8s] ERROR: Neither envoy nor docker available. Cannot run integration tests."
    kill "$POOL_PID" "$ROUTING_PID" 2>/dev/null
    exit 1
  fi

  echo "[adapter-k8s] Starting Envoy on :8080 (${ENVOY_CMD%% *})..."
  $ENVOY_CMD -c "${ENVOY_CONFIG_ARG}" --log-level warn >> .adapter-envoy.log 2>&1 &
  ENVOY_PID=$!
  echo "${ENVOY_PID}" > .adapter-envoy.pid

  # If docker, get the container ID
  if [[ "$ENVOY_CMD" == docker* ]]; then
    sleep 1
    ENVOY_CONTAINER=$(docker ps -q --filter "ancestor=envoyproxy/envoy:v1.32-latest" | head -1)
    echo "${ENVOY_CONTAINER}" > .adapter-envoy-container
  fi
} >&2

# --- 6. Wait for all services ---
{
  echo "[adapter-k8s] Waiting for services..."
  ATTEMPTS=0
  MAX_ATTEMPTS=60
  while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
    # Check all three ports
    POOL_OK=$(node -e "const socket=require('net').createConnection(3000,'127.0.0.1');socket.on('connect',()=>{socket.destroy();process.exit(0)});socket.on('error',()=>process.exit(1));setTimeout(()=>{socket.destroy();process.exit(1)},300)" 2>/dev/null && echo "1" || echo "0")
    ROUTING_OK=$(node -e "const socket=require('net').createConnection(8443,'127.0.0.1');socket.on('connect',()=>{socket.destroy();process.exit(0)});socket.on('error',()=>process.exit(1));setTimeout(()=>{socket.destroy();process.exit(1)},300)" 2>/dev/null && echo "1" || echo "0")
    ENVOY_OK=$(node -e "const socket=require('net').createConnection(8080,'127.0.0.1');socket.on('connect',()=>{socket.destroy();process.exit(0)});socket.on('error',()=>process.exit(1));setTimeout(()=>{socket.destroy();process.exit(1)},300)" 2>/dev/null && echo "1" || echo "0")

    if [ "$POOL_OK" = "1" ] && [ "$ROUTING_OK" = "1" ] && [ "$ENVOY_OK" = "1" ]; then
      echo "[adapter-k8s] All services ready"
      break
    fi

    # Check for crashes
    for PID_FILE in .adapter-pool.pid .adapter-routing.pid .adapter-envoy.pid; do
      if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ! kill -0 "$PID" 2>/dev/null; then
          SVC=$(basename "$PID_FILE" .pid | sed 's/\.adapter-//')
          echo "[adapter-k8s] ERROR: ${SVC} crashed"
          cat ".adapter-${SVC}.log" 2>/dev/null || true
          exit 1
        fi
      fi
    done

    ATTEMPTS=$((ATTEMPTS + 1))
    sleep 0.5
  done

  if [ $ATTEMPTS -eq $MAX_ATTEMPTS ]; then
    echo "[adapter-k8s] ERROR: Services failed to start within 30s"
    echo "=== Pool Server ===" && cat .adapter-server.log 2>/dev/null
    echo "=== Routing Service ===" && cat .adapter-routing.log 2>/dev/null
    echo "=== Envoy ===" && cat .adapter-envoy.log 2>/dev/null
    exit 1
  fi
} >&2

# --- 7. Output URL (Envoy proxy) ---
echo "http://127.0.0.1:8080"
