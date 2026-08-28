#!/usr/bin/env bash

set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$test_dir/../../.." && pwd)
shim_dir="$test_dir/shims"
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

output=$(bash "$repo_root/scripts/release.sh" check -- --help 2>&1)
[[ "$output" == *'Usage: bash scripts/release.sh check [--branch BRANCH]'* ]]

rsync -a --exclude='.git' --exclude='node_modules' --exclude='.wrangler' \
  --exclude='dist' "$repo_root/" "$temp_dir/repo/"
node -e '
const fs = require("node:fs");
const path = process.argv[1];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.version = "9.9.9";
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
' "$temp_dir/repo/packages/ui/package.json"
mkdir -p "$temp_dir/state"
: >"$temp_dir/invocations"
set +e
mismatch_output=$(env \
  PATH="$shim_dir:$PATH" \
  RELEASE_TEST_MODE=1 \
  RELEASE_SHIM_LOG="$temp_dir/invocations" \
  RELEASE_SHIM_STATE_DIR="$temp_dir/state" \
  bash "$temp_dir/repo/scripts/release.sh" check \
  --branch base/sweep-260826-release 2>&1)
mismatch_status=$?
set -e
[[ "$mismatch_status" == '1' ]]
[[ "$mismatch_output" == \
  *'Version mismatch: packages/ui/package.json=9.9.9; expected 0.0.0.'* ]]
if grep -q '^gh ' "$temp_dir/invocations"; then
  printf 'version mismatch unexpectedly reached GitHub\n' >&2
  exit 1
fi

printf 'check tests passed\n'
