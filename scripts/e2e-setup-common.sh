#!/usr/bin/env bash
set -euo pipefail

# SHARED E2E deploy SETUP — sourced by both topologies:
#   scripts/e2e-deploy.sh              Phase 1: pool server only
#   scripts/e2e-integration-deploy.sh  Phase 2: Envoy -> ext_proc -> pool
#
# Everything up to "start the tiers" lives here: packing the adapter once,
# normalizing the temp app's package manager, installing, building, and staging
# the pool config. The two scripts then start their own tiers and print the URL.
#
# WHY SHARED: these were copies, and the integration copy rotted. It never gained
# the ADAPTER_K8S_PREBUILT_TARBALL fast path (so it re-packed the adapter on EVERY
# deploy behind a serializing lock) nor the e2e-package-manager prep (so `npm install`
# in a pnpm fixture left `next` unresolvable and EVERY suite failed at setup with
# "We couldn't find the Next.js package"). Measured 2026-07-28: 85/85 suites failed
# before running a single assertion. One copy of this logic, so Phase 2 cannot
# silently drift behind Phase 1 again.
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
ADAPTER_PACK_LOCK_OWNER="${ADAPTER_PACK_LOCK_DIR}/owner"
ADAPTER_PACKAGE_NAME="@next-community/adapter-k8s"
ADAPTER_PACK_DIR=""
BUILD_CPUS="${ADAPTER_K8S_BUILD_CPUS:-4}"
BUILD_MAX_OLD_SPACE_MB="${ADAPTER_K8S_BUILD_MAX_OLD_SPACE_MB:-4096}"
export BUILD_CPUS BUILD_MAX_OLD_SPACE_MB
adapter_pack_lock_acquired=0
DEPLOY_LOG=".adapter-deploy.log"

cleanup_adapter_pack_lock() {
  if [ "$adapter_pack_lock_acquired" -eq 1 ]; then
    rm -f "$ADAPTER_PACK_LOCK_OWNER"
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

# On failure, dump the deploy log so the test harness shows it.
# The harness runs this script with stderr inherited (lost to the console) and
# only embeds stdout in the thrown error, so failure diagnostics must go to
# stdout to end up in the .results.json files. The URL-on-stdout contract only
# applies on success.
on_exit() {
  local exit_code=$?
  cleanup_adapter_pack_lock
  cleanup_adapter_pack_dir
  if [ "$exit_code" -ne 0 ]; then
    echo "=== DEPLOY FAILED (exit ${exit_code}) ==="
    if [ -f "$DEPLOY_LOG" ]; then
      echo "=== Deploy log (last 150 lines) ==="
      tail -n 150 "$DEPLOY_LOG"
    fi
    if [ -f ".adapter-server.log" ]; then
      echo "=== Server log (last 100 lines) ==="
      tail -n 100 .adapter-server.log
    fi
  fi
}

trap on_exit EXIT

# Tee all stderr to deploy log for diagnostics on failure
exec 2> >(tee -a "$DEPLOY_LOG" >&2)

# --- 1. Pack adapter and install it into the temp app ---
# Fast path: a prebuilt tarball (built + packed ONCE by the run wrapper) is
# reused across every deploy. This skips the per-deploy `npm run build` +
# `npm pack` — hundreds of redundant builds across a full suite — and the pack
# lock that serialized them. It also makes every deploy install the exact
# published file set, so a missing `files` entry or a dev-only dependency fails
# uniformly instead of per-fixture. Set ADAPTER_K8S_PREBUILT_TARBALL to enable.
if [ -n "${ADAPTER_K8S_PREBUILT_TARBALL:-}" ]; then
  if [ ! -f "$ADAPTER_K8S_PREBUILT_TARBALL" ]; then
    echo "[adapter-k8s] ADAPTER_K8S_PREBUILT_TARBALL set but missing: ${ADAPTER_K8S_PREBUILT_TARBALL}" >&2
    exit 1
  fi
  ADAPTER_TARBALL="$ADAPTER_K8S_PREBUILT_TARBALL"
  echo "[adapter-k8s] Using prebuilt tarball: ${ADAPTER_TARBALL}" >&2
else
  # Slow path: build + pack per deploy. Multiple deploy tests can share the same
  # adapter checkout. Serialize build + pack access so tarball creation sees a
  # consistent dist/ tree. Record the lock owner so an interrupted full-suite run
  # cannot poison every later deployment. A legitimate adapter build can take
  # longer than 30 seconds under c=4, so wait up to ten minutes for a live owner.
  for _attempt in $(seq 1 6000); do
    if mkdir "$ADAPTER_PACK_LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" > "$ADAPTER_PACK_LOCK_OWNER"
      adapter_pack_lock_acquired=1
      break
    fi

    lock_owner="$(cat "$ADAPTER_PACK_LOCK_OWNER" 2>/dev/null || true)"
    if [[ "$lock_owner" =~ ^[0-9]+$ ]] && ! kill -0 "$lock_owner" 2>/dev/null; then
      # Rename first: only one waiter can claim and remove this abandoned lock,
      # and no waiter can delete a newly acquired lock by mistake.
      stale_lock="${ADAPTER_PACK_LOCK_DIR}.stale.$$.$_attempt"
      if mv "$ADAPTER_PACK_LOCK_DIR" "$stale_lock" 2>/dev/null; then
        rm -rf "$stale_lock"
      fi
    elif [ -z "$lock_owner" ]; then
      # Older harness versions created ownerless locks. Only reclaim one after it
      # has remained untouched long enough that its creator cannot still be in
      # the mkdir-to-owner-file window.
      lock_age="$(( $(date +%s) - $(stat -c %Y "$ADAPTER_PACK_LOCK_DIR" 2>/dev/null || date +%s) ))"
      if [ "$lock_age" -ge 60 ]; then
        stale_lock="${ADAPTER_PACK_LOCK_DIR}.stale.$$.$_attempt"
        if mv "$ADAPTER_PACK_LOCK_DIR" "$stale_lock" 2>/dev/null; then
          rm -rf "$stale_lock"
        fi
      fi
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
fi

node "$ADAPTER_DIR/scripts/e2e-package-manager.mjs" prepare package.json \
  "$ADAPTER_PACKAGE_NAME" "$ADAPTER_TARBALL" >&2

# Next's deploy harness aliases NEXT_PRIVATE_TEST_MODE -> __NEXT_TEST_MODE
# in next.config.js for test-only client/runtime markers.
if [ -z "${NEXT_PRIVATE_TEST_MODE:-}" ] && [ -n "${NEXT_TEST_MODE:-}" ]; then
  export NEXT_PRIVATE_TEST_MODE="${NEXT_TEST_MODE}"
fi

# Cache-components bridge (survey batch 2, adapter-bun e2e-deploy.sh:170-176): the upstream
# harness sets ONE of these two names depending on Next version. If only one is honored, the
# cache-components/PPR suites silently build WITHOUT cacheComponents and "pass" for the wrong
# reason. Mirror whichever is set into the other so both spellings are always present.
if [ -n "${__NEXT_CACHE_COMPONENTS:-}" ] && [ -z "${NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS:-}" ]; then
  export NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS="${__NEXT_CACHE_COMPONENTS}"
fi
if [ -n "${NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS:-}" ] && [ -z "${__NEXT_CACHE_COMPONENTS:-}" ]; then
  export __NEXT_CACHE_COMPONENTS="${NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS}"
fi

# --- 2. Install dependencies ---
# The test harness creates package.json with next/react deps but skips install.
# The deploy script must install them.
#
# Some fixtures ship a pre-seeded node_modules (e.g. middleware-general's
# shared-package) that a fresh install would wipe. Mirror the harness's own
# Vercel workaround (test/lib/next-modes/base.ts installCommand): set the
# seeded packages aside, install, then copy them back over the result.
SEEDED_NODE_MODULES=""
if [ -d node_modules ]; then
  SEEDED_NODE_MODULES=".fixture-node-modules"
  rm -rf "$SEEDED_NODE_MODULES"
  mv node_modules "$SEEDED_NODE_MODULES"
fi
echo "[adapter-k8s] Installing fixture dependencies..." >&2
FIXTURE_PACKAGE_MANAGER="$(node "$ADAPTER_DIR/scripts/e2e-package-manager.mjs" package.json)"
if [ "$FIXTURE_PACKAGE_MANAGER" = "npm" ]; then
  npm install --legacy-peer-deps >&2
elif command -v pnpm &>/dev/null; then
  pnpm install --no-frozen-lockfile >&2
else
  npm install --legacy-peer-deps >&2
fi
if [ -n "$SEEDED_NODE_MODULES" ]; then
  echo "[adapter-k8s] Restoring fixture-seeded node_modules..." >&2
  # Replace whole entries rather than copying into them: pnpm's top-level
  # entries are symlinks into its store, and cp into a symlink would follow
  # it and mutate the shared store.
  restore_seeded() {
    local rel="$1"
    rm -rf "node_modules/${rel}"
    mkdir -p "$(dirname "node_modules/${rel}")"
    cp -a "${SEEDED_NODE_MODULES}/${rel}" "node_modules/${rel}"
  }
  while IFS= read -r entry; do
    name="$(basename "$entry")"
    if [[ "$name" == @* ]]; then
      while IFS= read -r scoped; do
        restore_seeded "${name}/$(basename "$scoped")"
      done < <(find "$entry" -mindepth 1 -maxdepth 1)
    else
      restore_seeded "$name"
    fi
  done < <(find "$SEEDED_NODE_MODULES" -mindepth 1 -maxdepth 1)
  rm -rf "$SEEDED_NODE_MODULES"
fi

ADAPTER_INSTALL_DIR="${PWD}/node_modules/@next-community/adapter-k8s"
NEXT_ADAPTER_PATH_LOCAL="${ADAPTER_INSTALL_DIR}/dist/index.js"
POOL_SERVER_CJS_LOCAL="${ADAPTER_INSTALL_DIR}/dist/pool-server.cjs"
# Phase 2 runs this tier too; both come from the INSTALLED package so the suite exercises
# the packed artifact rather than the working-tree dist.
ROUTING_SERVICE_CJS_LOCAL="${ADAPTER_INSTALL_DIR}/dist/routing-service.cjs"

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
# The cluster topology (e2e-cluster-deploy.sh) needs the staged context to build an
# image, so it presets this to 0; default stays 1 for the two local topologies.
export ADAPTER_K8S_SKIP_STAGING="${ADAPTER_K8S_SKIP_STAGING:-1}"
echo "[adapter-k8s] Build profile: cpus=${BUILD_CPUS}" >&2

# Equivalent to passing --experimental-next-config-strip-types to
# next build/start: enables Node's native TS loading for next.config.ts.
# The next-config-ts-native-ts fixtures have top-level await in their configs,
# which the legacy swc+require() fallback cannot load. Must be exported (not a
# CLI arg) so the pool server's runtime config load gets it too, and because
# `pnpm run build -- <arg>` would append to the last command of compound
# scripts. Harmless when native TS is unavailable: the loader falls back.
export __NEXT_NODE_NATIVE_TS_LOADER_ENABLED=true

# Mint the deployment ID before the build so Next.js bakes it into
# config.deploymentId (client bundles append ?dpl= to asset requests and
# runtime code reads process.env.NEXT_DEPLOYMENT_ID). Tests compare against
# the DEPLOYMENT_ID marker we report, so build, server, and marker must agree.
#
# ...EXCEPT on a real cluster. Setting deploymentId makes Next return a LITERAL CONSTANT
# from getBuildId (packages/next/src/build/index.ts: `return 'build-TfctsWXpff2fKS'`), so
# every app in every suite builds under the same id. The adapter derives blue/green resource
# names, the CDN cutover cache-tag, and the `k8s:<buildId>:` Valkey namespace from it — so
# suites would overwrite each other's Deployments and SHARE cache entries. `adapter-k8s
# deploy` correctly refuses that cutover, which would block every suite after the first.
# Nothing is lost by omitting it here: skew protection is already carried by the per-build
# build id, and `?dpl=` asset versioning is moot because the adapter enables immutable
# (content-addressed) assets. The marker is then reported as the build id, below.
if [ "${ADAPTER_K8S_SET_DEPLOYMENT_ID:-1}" = "1" ]; then
  DEPLOYMENT_ID="k8s-$(node -e "console.log(require('crypto').randomBytes(6).toString('hex'))")"
  export NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}"
else
  DEPLOYMENT_ID=""
  unset NEXT_DEPLOYMENT_ID
fi

# --- 3. Build ---
# Fixtures can define a package.json build script with pre-build setup steps
# (e.g. middleware-general's `setup` copies a local package into node_modules),
# so prefer `run build` over invoking `next build` directly.
echo "[adapter-k8s] Building..." >&2
BUILD_SCRIPT="$(node -e "
const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
process.stdout.write(pkg?.scripts?.build ?? '');
" 2>/dev/null || true)"
if [ -n "$BUILD_SCRIPT" ]; then
  echo "[adapter-k8s] Using package.json build script: ${BUILD_SCRIPT}" >&2
  if [ "$FIXTURE_PACKAGE_MANAGER" = "npm" ]; then
    npm run build >&2
  elif command -v pnpm &>/dev/null; then
    pnpm run build >&2
  else
    npm run build >&2
  fi
elif [ -f node_modules/next/dist/bin/next ]; then
  node node_modules/next/dist/bin/next build >&2
elif [ -f node_modules/.bin/next ]; then
  node_modules/.bin/next build >&2
else
  npx next build >&2
fi

BUILD_ID="$(cat .next/BUILD_ID 2>/dev/null || echo unknown)"
# With deploymentId omitted (see above), the per-build build id IS the deployment identity —
# it is what the RSC payload carries and what the client compares on for skew.
[ -n "$DEPLOYMENT_ID" ] || DEPLOYMENT_ID="$BUILD_ID"
# Report immutable-asset support from the ACTUAL build output, so the harness's asset-URL/?dpl
# expectations match what shipped. Next does NOT persist experimental.supportsImmutableAssets into
# required-server-files.json, so reading the config there always yields undefined→0 even when the
# HTML references /_next/static/immutable/* (no ?dpl). Detect instead by the immutable artifacts Next
# emits only when the flag is active for this build: the immutable/ static dir + the hashes manifest.
if [ -d .next/static/immutable ] || [ -f .next/immutable-static-hashes.json ]; then
  SUPPORTS_IMMUTABLE=1
else
  SUPPORTS_IMMUTABLE=0
fi
{
  echo "BUILD_ID: ${BUILD_ID}"
  echo "DEPLOYMENT_ID: ${DEPLOYMENT_ID}"
  echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: ${SUPPORTS_IMMUTABLE}"
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

