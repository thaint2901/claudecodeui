#!/usr/bin/env bash
# Run a test command and fail if fewer than $2 tests actually passed.
#
# Node's test runner exits 0 when a glob matches zero files, so a test script whose
# glob stopped matching (a renamed directory, a changed extension) looks exactly like
# a green suite. The floor turns that silent pass into a hard failure.
#
# Usage: scripts/ci-test-floor.sh "npm run test:server" 200
set -euo pipefail

cmd="${1:?usage: ci-test-floor.sh <command> <minimum-passing-tests>}"
floor="${2:?usage: ci-test-floor.sh <command> <minimum-passing-tests>}"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

set +e
eval "$cmd" 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"
set -e
if [ "$status" -ne 0 ]; then
  exit "$status"
fi

passed="$(sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -E '^[^ ]+ pass [0-9]+$' | tail -1 | awk '{print $3}')"
passed="${passed:-0}"

if [ "$passed" -lt "$floor" ]; then
  echo "::error::only ${passed} tests passed, expected at least ${floor} — did a test glob stop matching?"
  exit 1
fi

echo "${passed} tests passed (floor ${floor})"
