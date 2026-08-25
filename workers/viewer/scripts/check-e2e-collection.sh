#!/usr/bin/env bash
set -euo pipefail

output="$(pnpm exec playwright test --list --grep '@smoke')"
printf '%s\n' "$output"
count="$(printf '%s\n' "$output" | awk '/^Total: [0-9]+ tests?/ { print $2 }' | tail -n 1)"

if [[ -z "$count" || "$count" -lt 1 ]]; then
  echo "FAIL: Playwright collected 0 @smoke tests" >&2
  exit 1
fi
