#!/usr/bin/env bash
set -euo pipefail

# SMOKE SET: the ~35-minute regression gate. Runs the suites that historically move when
# dispatch/valkey-cache/routing change — every currently-red suite plus the families that
# have regressed at least once (matrix v6 3→13, segment-cache v12, interception, rewrites,
# not-found, i18n). Use this to close a fix batch; the FULL lane run (e2e-lanes.sh) is the
# nightly drift detector, not the per-batch gate. Compare results BY PER-SUITE COUNTS.
#
# Usage:
#   ./scripts/e2e-smoke.sh [lanes] [nextjs-ref]
#
# Honors ADAPTER_K8S_PREBUILT_TARBALL (packs once itself when unset, like e2e-lanes.sh).

LANES="${1:-6}"
NEXTJS_REF="${2:-v16.3.0-canary.97}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "${SCRIPT_DIR}/e2e-run-tmpdir.sh"
RUN_DIR="${ADAPTER_DIR}/.k8s-adapter/lane-runs/$(date +%Y%m%dT%H%M%S)-smoke"
mkdir -p "$RUN_DIR"
touch "${RUN_DIR}/.run-start"

TMP_ROOT="${E2E_LANES_TMPDIR:-$HOME/.cache/adapter-k8s-e2e-tmp}"
RUN_TMPDIR="$(create_e2e_run_tmpdir "$TMP_ROOT")"
TMP_ROOT="$(dirname "$RUN_TMPDIR")"
cleanup_run_tmpdir() {
  cleanup_e2e_run_tmpdir "$TMP_ROOT" "$RUN_TMPDIR" "$ADAPTER_DIR" || true
}
E2E_RUN_PIDS=()
stop_run() {
  local exit_code="$1"
  trap - INT TERM HUP
  stop_e2e_children "${E2E_RUN_PIDS[@]}"
  exit "$exit_code"
}
trap 'stop_run 130' INT
trap 'stop_run 143' TERM
trap 'stop_run 129' HUP
trap cleanup_run_tmpdir EXIT
export TMPDIR="$RUN_TMPDIR"
# e2e-local-cluster.sh consumes this override. Point it at the scoped child, not its parent.
export E2E_LANES_TMPDIR="$RUN_TMPDIR"

# DISK GUARD (2026-08-03): ~1,100 suite deploys accumulate ~1.8TB of docker build cache and
# ~14k images; at 96% host disk the k3d node hit DiskPressure, kubelet EVICTED the Envoy
# gateway, and an entire smoke run all-failed with ERR_EMPTY_RESPONSE (236/236 — pure
# infra). Cap the cache and drop this run's superseded e2e images up front.
docker builder prune -f --keep-storage 100gb >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true

if [ -z "${ADAPTER_K8S_PREBUILT_TARBALL:-}" ]; then
  echo "→ Building + packing adapter once for all lanes..."
  (cd "$ADAPTER_DIR" && npm run build >/dev/null)
  PACK_DIR="${RUN_DIR}/adapter-pack"
  mkdir -p "$PACK_DIR"
  PACK_JSON="$(cd "$ADAPTER_DIR" && npm pack --json --ignore-scripts --pack-destination "$PACK_DIR")"
  ADAPTER_K8S_PREBUILT_TARBALL="$PACK_DIR/$(
    node -e "console.log(JSON.parse(process.argv[1])[0].filename)" "$PACK_JSON"
  )"
  export ADAPTER_K8S_PREBUILT_TARBALL
  echo "→ Adapter tarball: ${ADAPTER_K8S_PREBUILT_TARBALL}"
fi

# One entry per suite (jest test-pattern fragments, matched against the test file path).
# Keep RED suites and SENSITIVE-green suites together — the point is catching both fixes
# and regressions in one run. Ordered roughly slowest-first so round-robin balances lanes.
SMOKE_SUITES=(
  # slow / multi-test heavyweights first
  "e2e/app-dir/actions/app-action.test"
  "e2e/app-dir/actions/app-action-node-middleware"
  "e2e/app-dir/cache-components-prerender-matrix/"
  "e2e/prerender.test"
  "e2e/middleware-general/"
  "e2e/getserversideprops/"
  # PPR / materialization family
  "e2e/app-dir/fallback-shells/"
  "e2e/app-dir/sub-shell-generation/"
  "e2e/app-dir/sub-shell-generation-middleware/"
  "e2e/app-dir/resume-data-cache/"
  "e2e/app-dir/partial-fallback-shell-upgrade/"
  "e2e/fallback-route-params/"
  "e2e/app-dir/revalidate-reason"
  "e2e/app-dir/cache-components-allow-otel-spans/"
  # segment-cache family (v12 regression surface)
  "e2e/app-dir/segment-cache/cached-navigations/"
  "e2e/app-dir/segment-cache/prefetch-app-shell-cached-gsp/"
  "e2e/app-dir/segment-cache/prefetch-inlining/"
  "e2e/app-dir/segment-cache/vary-params-base-dynamic/"
  # interception + rewrites (routing surface)
  "e2e/app-dir/interception-dynamic-segment-middleware/"
  "e2e/app-dir/interception-middleware-rewrite/"
  "e2e/basepath/redirect-and-rewrite"
  "e2e/rewrites-manual-href-as/"
  # not-found / status contracts
  "e2e/app-dir/not-found-non-document/"
  "e2e/app-dir/not-found-non-document-dynamic/"
  "e2e/app-dir/metadata-navigation/"
  # cache-tag / misc red tail
  "e2e/app-dir/non-ascii-cache-tags/"
  # Not no-duplicate-headers-middleware: that suite asserts next start's CDN-less
  # `max-age=1234` response. In the production topology Cloud CDN precedes ext_proc, so the
  # cluster must answer `no-cache` or a hit can bypass middleware. The pool header suites enforce
  # that adapter policy; the separately invoked live suite proves it through a deployed gateway.
  "e2e/app-dir/catch-error/"
  "e2e/app-dir/action-forward-loop/"
  "e2e/app-dir/concurrent-navigations/mismatching-prefetch"
  "e2e/i18n-support-same-page-hash-change/"
)

echo "=== Smoke run: ${#SMOKE_SUITES[@]} suite patterns across ${LANES} lanes ==="
echo "ref:  ${NEXTJS_REF}"
echo "logs: ${RUN_DIR}/"

# Round-robin the suite list into per-lane alternation patterns.
declare -a LANE_PATTERNS
for i in "${!SMOKE_SUITES[@]}"; do
  idx=$((i % LANES))
  LANE_PATTERNS[idx]="${LANE_PATTERNS[idx]:+${LANE_PATTERNS[idx]}|}${SMOKE_SUITES[i]}"
done

for ((lane = 0; lane < LANES; lane++)); do
  [ -z "${LANE_PATTERNS[lane]:-}" ] && continue
  log="${RUN_DIR}/smoke-lane$((lane + 1)).log"
  echo "[lane $((lane + 1))] $(tr '|' ' ' <<<"${LANE_PATTERNS[lane]}" | wc -w) suites → ${log}"
  E2E_LANE="$((lane + 1))" bash "${SCRIPT_DIR}/e2e-local-cluster.sh" \
    "${LANE_PATTERNS[lane]}" "$NEXTJS_REF" > "$log" 2>&1 &
  E2E_RUN_PIDS+=($!)
done

FAILED=0
for pid in "${E2E_RUN_PIDS[@]}"; do
  wait "$pid" || FAILED=1
done

# Aggregate exactly like e2e-lanes.sh, deriving NEXTJS_DIR instead of assuming one
# contributor's checkout path. A zero-file aggregate fails the run.
node "${SCRIPT_DIR}/e2e-aggregate-results.mjs" "$RUN_DIR"
exit "$FAILED"
