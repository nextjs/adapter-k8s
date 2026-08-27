#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./e2e-lock.sh
source "${SCRIPT_DIR}/e2e-lock.sh"

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/adapter-k8s-lock-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
export E2E_LOCK_POLL_SECONDS=0.01

LOCK_DIR="${TEST_DIR}/lock"
e2e_lock_acquire "$LOCK_DIR" 1 1
test "$(cat "${LOCK_DIR}/owner")" = "${BASHPID:-$$}"
if e2e_lock_acquire "$LOCK_DIR" 1 0; then
  echo "active lock was reclaimed" >&2
  exit 1
fi
e2e_lock_release "$LOCK_DIR"
test ! -e "$LOCK_DIR"

mkdir "$LOCK_DIR"
printf '%s\n' 99999999 > "${LOCK_DIR}/owner"
e2e_lock_acquire "$LOCK_DIR" 1 1
test "$(cat "${LOCK_DIR}/owner")" = "${BASHPID:-$$}"
e2e_lock_release "$LOCK_DIR"

mkdir "$LOCK_DIR"
touch -t 200001010000 "$LOCK_DIR"
e2e_lock_acquire "$LOCK_DIR" 1 1
test "$(cat "${LOCK_DIR}/owner")" = "${BASHPID:-$$}"
e2e_lock_release "$LOCK_DIR"

echo "e2e lock tests passed"
