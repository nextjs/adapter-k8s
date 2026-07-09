#!/usr/bin/env bash
set -euo pipefail

FIREBASE_TOOLS_VERSION="${FIREBASE_TOOLS_BASELINE_VERSION:-latest}"
PROJECT_ID="${FIREBASE_BASELINE_PROJECT_ID:-demo-adapter-k8s}"
PORT="${FIREBASE_BASELINE_HOSTING_PORT:-5000}"
UI_PORT="${FIREBASE_BASELINE_UI_PORT:-4000}"

echo "[firebase-baseline] Installing firebase-tools@${FIREBASE_TOOLS_VERSION}..." >&2

node - <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.devDependencies = pkg.devDependencies || {};
pkg.devDependencies['firebase-tools'] = process.env.FIREBASE_TOOLS_BASELINE_VERSION || 'latest';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
NODE

npm install --no-frozen-lockfile --ignore-scripts >&2 2>&1 || true

cat > .firebaserc <<EOF
{
  "projects": {
    "default": "${PROJECT_ID}"
  }
}
EOF

cat > firebase.json <<EOF
{
  "emulators": {
    "hosting": {
      "port": ${PORT}
    },
    "ui": {
      "enabled": false,
      "port": ${UI_PORT}
    },
    "singleProjectMode": true
  },
  "hosting": {
    "source": ".",
    "ignore": [
      "firebase.json",
      ".firebaserc",
      "**/.*",
      "**/node_modules/**"
    ],
    "frameworksBackend": {
      "region": "us-central1"
    }
  }
}
EOF

export NEXT_TELEMETRY_DISABLED=1
export CI=1
export FIREBASE_CLI_PREVIEWS=webframeworks

echo "[firebase-baseline] Enabling webframeworks preview..." >&2
npx firebase experiments:enable webframeworks --project "${PROJECT_ID}" >&2 2>&1 || true

BUILD_ID="firebase-baseline"
DEPLOY_RANDOM="$(node -e "console.log(require('crypto').randomBytes(8).toString('base64url'))")"
export NEXT_DEPLOYMENT_ID="firebase-baseline-${DEPLOY_RANDOM}"
{
  echo "BUILD_ID: ${BUILD_ID}"
  echo "DEPLOYMENT_ID: ${NEXT_DEPLOYMENT_ID}"
  echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: 0"
} > .adapter-build.log

echo "[firebase-baseline] Starting emulator on :${PORT}..." >&2
NODE_ENV=production npx firebase emulators:start --only hosting --project "${PROJECT_ID}" >> .adapter-server.log 2>&1 &
SERVER_PID=$!
echo "${SERVER_PID}" > .adapter-server.pid

ATTEMPTS=0
while [ $ATTEMPTS -lt 120 ]; do
  if node -e "fetch('http://127.0.0.1:${PORT}/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    echo "[firebase-baseline] Ready on :${PORT}" >&2
    echo "http://127.0.0.1:${PORT}"
    exit 0
  fi

  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[firebase-baseline] Emulator crashed" >&2
    cat .adapter-server.log >&2 || true
    exit 1
  fi

  ATTEMPTS=$((ATTEMPTS + 1))
  sleep 0.5
done

echo "[firebase-baseline] TIMEOUT waiting for emulator" >&2
cat .adapter-server.log >&2 || true
exit 1
