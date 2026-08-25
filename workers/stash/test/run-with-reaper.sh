#!/usr/bin/env bash
set -uo pipefail

STASH_ADMIN_TOKEN=test-admin setsid pnpm exec vitest run "$@" &
test_process=$!

cleanup() {
  kill -TERM -- "-$test_process" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

set +e
wait "$test_process"
status=$?
set -e
cleanup
trap - EXIT INT TERM
exit "$status"
