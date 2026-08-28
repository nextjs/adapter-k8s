#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./e2e-next-checkout.sh
source "${SCRIPT_DIR}/e2e-next-checkout.sh"

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/adapter-k8s-next-checkout-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
REMOTE="${TEST_DIR}/remote"
git init -q "$REMOTE"
git -C "$REMOTE" config user.name adapter-k8s-test
git -C "$REMOTE" config user.email adapter-k8s-test@example.invalid
printf '%s\n' tag > "${REMOTE}/fixture.txt"
git -C "$REMOTE" add fixture.txt
git -C "$REMOTE" commit -q -m tag
TAG_COMMIT="$(git -C "$REMOTE" rev-parse HEAD)"
git -C "$REMOTE" tag v1.0.0
printf '%s\n' branch > "${REMOTE}/fixture.txt"
git -C "$REMOTE" commit -q -am branch
BRANCH_COMMIT="$(git -C "$REMOTE" rev-parse HEAD)"
git -C "$REMOTE" branch -m feature/checkout-test
BRANCH="feature/checkout-test"

e2e_next_checkout_ref "${TEST_DIR}/branch" "$REMOTE" "$BRANCH"
test "$(git -C "${TEST_DIR}/branch" rev-parse HEAD)" = "$BRANCH_COMMIT"
e2e_next_checkout_ref "${TEST_DIR}/tag" "$REMOTE" v1.0.0
test "$(git -C "${TEST_DIR}/tag" rev-parse HEAD)" = "$TAG_COMMIT"
e2e_next_checkout_ref "${TEST_DIR}/sha" "$REMOTE" "$TAG_COMMIT"
test "$(git -C "${TEST_DIR}/sha" rev-parse HEAD)" = "$TAG_COMMIT"

mkdir "${TEST_DIR}/nonempty"
printf '%s\n' operator-data > "${TEST_DIR}/nonempty/fixture.txt"
if e2e_next_checkout_ref "${TEST_DIR}/nonempty" "$REMOTE" "$BRANCH"; then
  echo "nonempty checkout directory was accepted" >&2
  exit 1
fi
test "$(cat "${TEST_DIR}/nonempty/fixture.txt")" = operator-data

if e2e_next_checkout_ref "${TEST_DIR}/unsafe-ref" "$REMOTE" --upload-pack=unexpected; then
  echo "option-shaped ref was accepted" >&2
  exit 1
fi

echo "e2e Next checkout tests passed"
