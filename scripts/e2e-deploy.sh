#!/usr/bin/env bash
set -euo pipefail

# Next.js Adapter E2E Deploy Script
#
# Contract (from nextjs.org/docs/.../adapterPath#testing-adapters):
# - cwd is set to the isolated test app by the harness
# - Exit non-zero on failure
# - Print deployment URL to stdout (nothing else)
# - Write diagnostics to stderr or files

ADAPTER_DIR="${ADAPTER_DIR:?ADAPTER_DIR must be set}"
ADAPTER_DIR="$(cd "$ADAPTER_DIR" && pwd -P)"
TEST_DIR="$PWD"
ADAPTER_DIST_INDEX="${ADAPTER_DIR}/dist/index.js"
ADAPTER_PACK_LOCK_DIR="${ADAPTER_DIR}/.e2e-deploy-pack.lock"
ADAPTER_PACKAGE_NAME="@next-community/adapter-k8s"
ADAPTER_PACK_DIR=""
BUILD_CPUS="${ADAPTER_K8S_BUILD_CPUS:-4}"
BUILD_MAX_OLD_SPACE_MB="${ADAPTER_K8S_BUILD_MAX_OLD_SPACE_MB:-4096}"
export BUILD_CPUS BUILD_MAX_OLD_SPACE_MB
adapter_pack_lock_acquired=0
DEPLOY_LOG=".adapter-deploy.log"

cleanup_adapter_pack_lock() {
  if [ "$adapter_pack_lock_acquired" -eq 1 ]; then
    rmdir "$ADAPTER_PACK_LOCK_DIR" 2>/dev/null || true
    adapter_pack_lock_acquired=0
  fi
}

cleanup_adapter_pack_dir() {
  if [ -n "${ADAPTER_PACK_DIR}" ] && [ -d "${ADAPTER_PACK_DIR}" ]; then
    rm -rf "${ADAPTER_PACK_DIR}"
    ADAPTER_PACK_DIR=""
  fi
}

# On failure, dump the deploy log so the test harness shows it
on_exit() {
  local exit_code=$?
  cleanup_adapter_pack_lock
  cleanup_adapter_pack_dir
  if [ "$exit_code" -ne 0 ] && [ -f "$DEPLOY_LOG" ]; then
    echo "=== DEPLOY FAILED (exit ${exit_code}) ===" >&2
    cat "$DEPLOY_LOG" >&2
    # Also dump server log if it exists
    [ -f ".adapter-server.log" ] && cat .adapter-server.log >&2
  fi
}

trap on_exit EXIT

# Tee all stderr to deploy log for diagnostics on failure
exec 2> >(tee -a "$DEPLOY_LOG" >&2)

# --- 1. Pack adapter and install it into the temp app ---
# Multiple deploy tests can share the same adapter checkout.
# Serialize pack access so tarball creation sees a consistent dist/ tree.
for _attempt in $(seq 1 300); do
  if mkdir "$ADAPTER_PACK_LOCK_DIR" 2>/dev/null; then
    adapter_pack_lock_acquired=1
    break
  fi
  sleep 0.1
done

if [ "$adapter_pack_lock_acquired" -ne 1 ]; then
  echo "Timed out waiting for adapter pack lock: ${ADAPTER_PACK_LOCK_DIR}" >&2
  exit 1
fi

echo "[adapter-k8s] Building adapter package..." >&2
(
  cd "$ADAPTER_DIR"
  npm run build >&2
)

if [ ! -f "$ADAPTER_DIST_INDEX" ]; then
  echo "[adapter-k8s] Adapter dist build failed; missing ${ADAPTER_DIST_INDEX}" >&2
  exit 1
fi

ADAPTER_PACK_DIR="$(mktemp -d /tmp/adapter-k8s-pack-XXXXXX)"
PACK_RESULT="$(
  cd "$ADAPTER_DIR"
  npm pack --json --ignore-scripts --pack-destination "$ADAPTER_PACK_DIR"
)"
ADAPTER_TARBALL="$ADAPTER_PACK_DIR/$(
  node -e "const result = JSON.parse(process.argv[1]); console.log(result[0].filename)" "$PACK_RESULT"
)"
cleanup_adapter_pack_lock

if [ ! -f "$ADAPTER_TARBALL" ]; then
  echo "[adapter-k8s] Packed tarball missing: ${ADAPTER_TARBALL}" >&2
  exit 1
fi

node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['${ADAPTER_PACKAGE_NAME}'] = 'file:${ADAPTER_TARBALL}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
" >&2

# Next's deploy harness aliases NEXT_PRIVATE_TEST_MODE -> __NEXT_TEST_MODE
# in next.config.js for test-only client/runtime markers.
if [ -z "${NEXT_PRIVATE_TEST_MODE:-}" ] && [ -n "${NEXT_TEST_MODE:-}" ]; then
  export NEXT_PRIVATE_TEST_MODE="${NEXT_TEST_MODE}"
fi

# --- 2. Install dependencies ---
# The test harness creates package.json with next/react deps but skips install.
# The deploy script must install them.
echo "[adapter-k8s] Installing fixture dependencies..." >&2
if command -v pnpm &>/dev/null; then
  pnpm install --no-frozen-lockfile >&2
else
  npm install --legacy-peer-deps >&2
fi

ADAPTER_INSTALL_DIR="${PWD}/node_modules/@next-community/adapter-k8s"
NEXT_ADAPTER_PATH_LOCAL="${ADAPTER_INSTALL_DIR}/dist/index.js"
POOL_SERVER_CJS_LOCAL="${ADAPTER_INSTALL_DIR}/dist/pool-server.cjs"

if [ ! -f "$NEXT_ADAPTER_PATH_LOCAL" ]; then
  echo "[adapter-k8s] Installed adapter dist missing: ${NEXT_ADAPTER_PATH_LOCAL}" >&2
  exit 1
fi
if [ ! -f "$POOL_SERVER_CJS_LOCAL" ]; then
  echo "[adapter-k8s] Installed pool server missing: ${POOL_SERVER_CJS_LOCAL}" >&2
  exit 1
fi

export NEXT_ADAPTER_PATH="$NEXT_ADAPTER_PATH_LOCAL"
echo "[adapter-k8s] NEXT_ADAPTER_PATH=${NEXT_ADAPTER_PATH}" >&2

# Keep local deploy builds conservative. The largest failing suites appear to
# die during "Collecting page data using 31 workers ..." with no useful error.
if [[ " ${NODE_OPTIONS:-} " != *" --max-old-space-size="* ]]; then
  export NODE_OPTIONS="--max-old-space-size=${BUILD_MAX_OLD_SPACE_MB} ${NODE_OPTIONS:-}"
fi
echo "[adapter-k8s] NODE_OPTIONS=${NODE_OPTIONS}" >&2

# The pool server supports both Node.js and Edge middleware runtimes.
# Node middleware is loaded directly; Edge middleware uses Next.js's built-in
# edge sandbox (same mechanism as `next start`). No runtime forcing needed.

# Build profile is applied via the adapter's modifyConfig() API — no config file
# hacking needed. Just set the env var to activate it.
export ADAPTER_K8S_BUILD_CPUS="${BUILD_CPUS}"
# Skip Docker context staging — pool server reads from .next/ directly.
# This saves thousands of inodes in /tmp which is critical for large e2e runs.
export ADAPTER_K8S_SKIP_STAGING=1
echo "[adapter-k8s] Build profile: cpus=${BUILD_CPUS}" >&2

# --- 3. Build ---
echo "[adapter-k8s] Building..." >&2
# Use the local next binary if available, otherwise npx
if [ -f node_modules/next/dist/bin/next ]; then
  node node_modules/next/dist/bin/next build >&2
elif [ -f node_modules/.bin/next ]; then
  node_modules/.bin/next build >&2
else
  npx next build >&2
fi

BUILD_ID="$(cat .next/BUILD_ID 2>/dev/null || echo unknown)"
DEPLOYMENT_ID="k8s-$(node -e "console.log(require('crypto').randomBytes(6).toString('hex'))")"
{
  echo "BUILD_ID: ${BUILD_ID}"
  echo "DEPLOYMENT_ID: ${DEPLOYMENT_ID}"
  echo "IMMUTABLE_ASSET_TOKEN: undefined"
} > .adapter-build.log
echo "[adapter-k8s] Built. ID=${BUILD_ID}" >&2

# --- 4. Setup config ---
mkdir -p config
if [ -d ".k8s-adapter/output" ]; then
  cp .k8s-adapter/output/routing-manifest.json config/ 2>/dev/null || true
  cp .k8s-adapter/output/static-assets.json config/ 2>/dev/null || true
  find .k8s-adapter/output -name "pool-manifest-*.json" -exec cp {} config/ \; 2>/dev/null || true
fi
[ -f config/pool-manifest-default.json ] || echo '{"buildId":"'"${BUILD_ID}"'","poolName":"default","outputs":{}}' > config/pool-manifest-default.json
[ -f config/routing-manifest.json ] || echo '{"routeGraph":{"beforeMiddleware":[],"beforeFiles":[],"afterFiles":[],"dynamicRoutes":[],"onMatch":[],"fallback":[],"shouldNormalizeNextData":false,"rsc":{}},"pathnames":[],"i18n":null,"buildId":"'"${BUILD_ID}"'","basePath":"","middleware":null,"poolAssignments":{},"pprRoutes":{},"nextVersion":"16.2.0"}' > config/routing-manifest.json

# --- 5. Start pool server ---
PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")
export PORT POOL_NAME=default NEXT_BUILD_ID="${BUILD_ID}" CONFIG_DIR="$(pwd)/config" NODE_ENV=production

echo "[adapter-k8s] Starting on :${PORT}..." >&2
echo "[adapter-k8s] Pool server CJS at: ${POOL_SERVER_CJS_LOCAL}" >&2
echo "[adapter-k8s] CONFIG_DIR=${CONFIG_DIR}" >&2
ls config/ >&2
node "${POOL_SERVER_CJS_LOCAL}" > .adapter-server.log 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > .adapter-server.pid
echo "[adapter-k8s] Server PID: ${SERVER_PID}" >&2
sleep 2
echo "[adapter-k8s] Server still running: $(kill -0 $SERVER_PID 2>/dev/null && echo yes || echo no)" >&2
echo "[adapter-k8s] Server log so far:" >&2
cat .adapter-server.log >&2

# --- 6. Wait for ready ---
for i in $(seq 1 60); do
  if node -e "const socket=require('net').createConnection(${PORT},'127.0.0.1');socket.on('connect',()=>{socket.destroy();process.exit(0)});socket.on('error',()=>process.exit(1));setTimeout(()=>{socket.destroy();process.exit(1)},400)" 2>/dev/null; then
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
