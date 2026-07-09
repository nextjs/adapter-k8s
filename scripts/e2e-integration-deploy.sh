#!/usr/bin/env bash
set -euo pipefail

# Next.js Adapter E2E Deploy Script — INTEGRATION MODE
#
# Starts the full split architecture locally via Envoy:
#   Envoy (:8080) → Routing Service ext_proc (:8443) → Pool Server (:3000)
#
# This validates the complete request flow including:
# - ext_proc header mutations (x-output-id, x-upstream-pool, x-matched-pathname)
# - Middleware execution in the routing service (pre-CDN)
# - beforeFiles/afterFiles rewrite resolution
# - Static asset bypass (or not — Envoy sends everything through ext_proc)
# - Handler invocation in the pool server via dispatch headers

ADAPTER_DIR="${ADAPTER_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

# --- 1. Install adapter into test fixture ---
{
  echo "[adapter-k8s] Installing adapter from ${ADAPTER_DIR}"
  TARBALL=$(cd "$ADAPTER_DIR" && npm pack --quiet 2>/dev/null | tail -1)
  TARBALL_PATH="${ADAPTER_DIR}/${TARBALL}"

  node -e "
    const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
    pkg.dependencies = pkg.dependencies || {};
    pkg.dependencies['@next-community/adapter-k8s'] = 'file:${TARBALL_PATH}';
    require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
  "
  npm install --no-frozen-lockfile --ignore-scripts 2>&1 || true
} >&2

# --- 2. Build with adapter ---
{
  export NEXT_ADAPTER_PATH="${ADAPTER_DIR}/dist/index.js"
  DEPLOY_RANDOM=$(node -e "console.log(require('crypto').randomBytes(8).toString('base64url'))")
  export NEXT_DEPLOYMENT_ID="k8s-adapter-${DEPLOY_RANDOM}"

  echo "[adapter-k8s] Building test app..."
  npx next build 2>&1

  BUILD_ID=$(cat .next/BUILD_ID 2>/dev/null || echo "unknown")
  {
    echo "BUILD_ID: ${BUILD_ID}"
    echo "DEPLOYMENT_ID: ${NEXT_DEPLOYMENT_ID}"
    echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: 0"
  } > .adapter-build.log
} >&2

# --- 3. Start Pool Server ---
{
  export POOL_NAME="default"
  export NEXT_BUILD_ID="${BUILD_ID}"
  export NODE_ENV="production"

  # Setup config from adapter output
  mkdir -p config
  if [ -d ".k8s-adapter/output" ]; then
    cp .k8s-adapter/output/routing-manifest.json config/ 2>/dev/null || true
    cp .k8s-adapter/output/static-assets.json config/ 2>/dev/null || true
    find .k8s-adapter/output -name "pool-manifest-*.json" -exec cp {} config/ \; 2>/dev/null || true
  fi

  if ! ls config/pool-manifest-*.json 1>/dev/null 2>&1; then
    node -e "
      const fs = require('fs');
      fs.writeFileSync('config/pool-manifest-default.json', JSON.stringify({
        buildId: '${BUILD_ID}', poolName: 'default', outputs: {}
      }, null, 2));
    "
  fi

  export CONFIG_DIR="${PWD}/config"
  export PORT=3000

  echo "[adapter-k8s] Starting pool server on :3000..."
  node "${ADAPTER_DIR}/dist/pool-server.cjs" >> .adapter-server.log 2>&1 &
  POOL_PID=$!
  echo "${POOL_PID}" > .adapter-pool.pid
} >&2

# --- 4. Start Routing Service ---
{
  export PORT=8443
  echo "[adapter-k8s] Starting routing service on :8443..."
  node "${ADAPTER_DIR}/dist/routing-service.cjs" >> .adapter-routing.log 2>&1 &
  ROUTING_PID=$!
  echo "${ROUTING_PID}" > .adapter-routing.pid
} >&2

# --- 5. Start Envoy ---
{
  # Check if Envoy is available
  if command -v envoy &>/dev/null; then
    ENVOY_CMD="envoy"
  elif docker image inspect envoyproxy/envoy:v1.32-latest &>/dev/null 2>&1 || docker pull envoyproxy/envoy:v1.32-latest >&2 2>&1; then
    ENVOY_CMD="docker run --rm --network host -v ${ADAPTER_DIR}/integration/envoy.yaml:/etc/envoy/envoy.yaml:ro envoyproxy/envoy:v1.32-latest"
  else
    echo "[adapter-k8s] ERROR: Neither envoy nor docker available. Cannot run integration tests."
    kill "$POOL_PID" "$ROUTING_PID" 2>/dev/null
    exit 1
  fi

  echo "[adapter-k8s] Starting Envoy on :8080..."
  $ENVOY_CMD -c /etc/envoy/envoy.yaml --log-level warn >> .adapter-envoy.log 2>&1 &
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
