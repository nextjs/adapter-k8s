#!/usr/bin/env bash
set -euo pipefail

# PHASE 2 lane driver: run timing-balanced groups of the upstream suite across N concurrent
# lanes on the local k3d cluster. Each lane is an independent release (own hostname, own
# state dir, own serial cutover lock); they share the merged Envoy data plane, the local
# registry, and Valkey.
#
# Usage:
#   ./scripts/e2e-lanes.sh <lanes> <total-groups> [first-group] [last-group] [nextjs-ref]
#
#   Pilot (2 lanes, groups 1-2 of 25 ≈ ~85 suites):
#     ./scripts/e2e-lanes.sh 2 25 1 2
#   Full run (6 lanes, all 6 groups):
#     ./scripts/e2e-lanes.sh 6 6
#
# Groups are assigned round-robin to lanes; each lane runs its groups SEQUENTIALLY (the
# per-lane lock makes concurrent deploys within a lane impossible anyway).
#
# STARTUP STAGGER: lane 1 launches alone first and the rest wait until it reaches
# "Running tests..." — the Next.js checkout prep (git fetch, pnpm install, build) is shared
# mutable state that N concurrent first-runs would race.

LANES="${1:?lanes required}"
TOTAL_GROUPS="${2:?total groups required}"
FIRST_GROUP="${3:-1}"
LAST_GROUP="${4:-$TOTAL_GROUPS}"
NEXTJS_REF="${5:-v16.3.0-canary.97}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_DIR="${ADAPTER_DIR}/.k8s-adapter/lane-runs/$(date +%Y%m%dT%H%M%S)"
mkdir -p "$RUN_DIR"

# DEDICATED TMPDIR on the real disk — never tmpfs. The harness creates one full Next app
# (node_modules included, ~150k inodes) per in-flight suite under os.tmpdir(); two lanes on
# the default 1M-inode /tmp tmpfs exhausted it mid-pilot (measured: 16 clean deploys, then
# ENOSPC mass-failed every suite after). The dir is exclusively ours, so wipe it at run
# start rather than trusting per-suite cleanup to never leak.
export TMPDIR="${E2E_LANES_TMPDIR:-$HOME/.cache/adapter-k8s-e2e-tmp}"
# Best-effort wipe: a previous run's straggler can still be writing here, and rm -rf races
# concurrent writes into ENOTEMPTY — which under `set -e` killed the whole run at launch.
# Stale files only cost disk; a failed wipe must never cost the run.
rm -rf "$TMPDIR" 2>/dev/null || true
mkdir -p "$TMPDIR"

echo "=== Phase 2 lane run ==="
echo "lanes:   ${LANES}"
echo "groups:  ${FIRST_GROUP}..${LAST_GROUP} of ${TOTAL_GROUPS}"
echo "ref:     ${NEXTJS_REF}"
echo "logs:    ${RUN_DIR}/"
echo ""

# Groups per lane, round-robin.
declare -a LANE_GROUPS
for ((g = FIRST_GROUP; g <= LAST_GROUP; g++)); do
  idx=$(((g - FIRST_GROUP) % LANES))
  LANE_GROUPS[idx]="${LANE_GROUPS[idx]:-} ${g}"
done

run_lane() {
  local lane="$1"
  shift
  local groups=("$@")
  local rc=0
  for g in "${groups[@]}"; do
    local log="${RUN_DIR}/lane${lane}-group${g}of${TOTAL_GROUPS}.log"
    echo "[lane ${lane}] group ${g}/${TOTAL_GROUPS} starting → ${log}"
    if ! E2E_LANE="$lane" bash "${SCRIPT_DIR}/e2e-local-cluster.sh" "" "$NEXTJS_REF" \
      "${g}/${TOTAL_GROUPS}" > "$log" 2>&1; then
      echo "[lane ${lane}] group ${g}/${TOTAL_GROUPS} FAILED (see log)"
      rc=1
    else
      echo "[lane ${lane}] group ${g}/${TOTAL_GROUPS} done"
    fi
  done
  return "$rc"
}

PIDS=()
for ((lane = 1; lane <= LANES; lane++)); do
  # shellcheck disable=SC2086
  groups=(${LANE_GROUPS[$((lane - 1))]:-})
  [ "${#groups[@]}" -eq 0 ] && continue
  run_lane "$lane" "${groups[@]}" &
  PIDS+=($!)
  if [ "$lane" -eq 1 ]; then
    # Stagger: wait for lane 1 to finish the shared checkout prep before the rest start.
    first_log="${RUN_DIR}/lane1-group${groups[0]}of${TOTAL_GROUPS}.log"
    for _i in $(seq 1 600); do
      grep -q "Running tests\.\.\." "$first_log" 2>/dev/null && break
      kill -0 "${PIDS[0]}" 2>/dev/null || break
      sleep 2
    done
  fi
done

FAILED=0
for pid in "${PIDS[@]}"; do
  wait "$pid" || FAILED=1
done

echo ""
echo "=== Lane run complete (failed=${FAILED}) ==="
# Aggregate per-suite results from the shared checkout: every results.json newer than this
# run's start belongs to it (lanes never run the same suite twice — groups are disjoint).
python3 - "$RUN_DIR" <<'EOF'
import glob, json, os, sys
run_dir = sys.argv[1]
start = os.path.getmtime(run_dir)
root = os.path.abspath(os.path.join(run_dir, "../../../..", ".adapter-k8s-e2e/next.js"))
tot = p = f = suites = 0
failed = []
for fn in glob.glob(os.path.join(root, "test/**/*.results.json"), recursive=True):
    if os.path.getmtime(fn) < start:
        continue
    try:
        d = json.load(open(fn))
    except Exception:
        continue
    suites += 1
    tot += d.get("numTotalTests", 0)
    p += d.get("numPassedTests", 0)
    f += d.get("numFailedTests", 0)
    if d.get("numFailedTests", 0):
        failed.append(os.path.relpath(fn, root))
print(f"suites={suites} tests={tot} passed={p} failed={f}")
for x in sorted(failed):
    print("  FAIL:", x)
EOF
exit "$FAILED"
