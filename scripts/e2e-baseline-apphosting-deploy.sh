#!/usr/bin/env bash
set -euo pipefail

ADAPTER_VERSION="${APPHOSTING_BASELINE_ADAPTER_VERSION:-latest}"

echo "[apphosting-baseline] Installing @apphosting/adapter-nextjs@${ADAPTER_VERSION}..." >&2

node - <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['@apphosting/adapter-nextjs'] = process.env.APPHOSTING_BASELINE_ADAPTER_VERSION || 'latest';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
NODE

npm install --no-frozen-lockfile --ignore-scripts >&2 2>&1 || true

FRAMEWORK_VERSION="$(node -p "require('./package.json').dependencies.next || ''" | sed 's/^[^0-9]*//')"
export FRAMEWORK_VERSION
export NEXT_TELEMETRY_DISABLED=1

echo "[apphosting-baseline] Building with apphosting-adapter-nextjs-build..." >&2
npx apphosting-adapter-nextjs-build >&2 2>&1

BUILD_ID="$(cat .next/BUILD_ID 2>/dev/null || echo unknown)"
DEPLOY_RANDOM="$(node -e "console.log(require('crypto').randomBytes(8).toString('base64url'))")"
export NEXT_DEPLOYMENT_ID="apphosting-baseline-${DEPLOY_RANDOM}"

{
  echo "BUILD_ID: ${BUILD_ID}"
  echo "DEPLOYMENT_ID: ${NEXT_DEPLOYMENT_ID}"
  echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: 0"
} > .adapter-build.log

RUN_COMMAND="$(node - <<'NODE'
const fs = require('fs');
const content = fs.readFileSync('.apphosting/bundle.yaml', 'utf8');
const match = content.match(/^\s*runCommand:\s*(.+)\s*$/m);
if (!match) {
  console.error('runCommand missing from .apphosting/bundle.yaml');
  process.exit(1);
}
console.log(match[1].trim());
NODE
)"

PORT="$(node -e "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});")"
export PORT
export HOSTNAME=127.0.0.1
export NODE_ENV=production

echo "[apphosting-baseline] Starting on :${PORT}..." >&2
echo "[apphosting-baseline] Run command: ${RUN_COMMAND}" >&2
/usr/bin/env bash -lc "${RUN_COMMAND}" >> .adapter-server.log 2>&1 &
SERVER_PID=$!
echo "${SERVER_PID}" > .adapter-server.pid

ATTEMPTS=0
while [ $ATTEMPTS -lt 60 ]; do
  if node -e "fetch('http://127.0.0.1:${PORT}/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    echo "[apphosting-baseline] Ready on :${PORT}" >&2
    echo "http://127.0.0.1:${PORT}"
    exit 0
  fi

  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[apphosting-baseline] Server crashed" >&2
    cat .adapter-server.log >&2 || true
    exit 1
  fi

  ATTEMPTS=$((ATTEMPTS + 1))
  sleep 0.5
done

echo "[apphosting-baseline] TIMEOUT waiting for server" >&2
cat .adapter-server.log >&2 || true
exit 1
