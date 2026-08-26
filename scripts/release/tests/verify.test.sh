#!/usr/bin/env bash
set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$test_dir/../../.." && pwd)
shim_dir="$test_dir/shims"
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
command_root=$repo_root

assert_contains() {
  local output=$1
  local expected=$2
  if [[ "$output" != *"$expected"* ]]; then
    printf 'expected output to contain %q, got:\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

run_verify() {
  local scenario=$1
  local expected_status=$2
  local expected_message=$3
  rm -rf "$temp_dir/state"
  mkdir -p "$temp_dir/state"
  : >"$temp_dir/invocations"
  local output actual_status
  set +e
  output=$(env \
    PATH="$shim_dir:$PATH" \
    RELEASE_TEST_MODE=1 \
    RELEASE_VERIFY_MAX_ATTEMPTS=2 \
    RELEASE_VERIFY_POLL_SECONDS=0 \
    RELEASE_SHIM_LOG="$temp_dir/invocations" \
    RELEASE_SHIM_STATE_DIR="$temp_dir/state" \
    NPM_SCENARIO="$scenario" \
    bash "$command_root/scripts/release.sh" verify 2>&1)
  actual_status=$?
  set -e
  if [[ "$actual_status" != "$expected_status" ]]; then
    printf 'scenario %s: expected status %s, got %s:\n%s\n' \
      "$scenario" "$expected_status" "$actual_status" "$output" >&2
    exit 1
  fi
  assert_contains "$output" "$expected_message"
  if grep -Ev '^npm (view|dist-tag) ' "$temp_dir/invocations" | grep -q .; then
    printf 'unexpected registry operation reached a shim\n' >&2
    exit 1
  fi
  if [[ "$scenario" == 'success' && "$expected_status" == '0' ]]; then
    for package_name in \
      '@takazudo/zudo-history-stash-core' \
      '@takazudo/zudo-history-stash' \
      '@takazudo/zudo-history-stash-ui'; do
      grep -Fxq "npm view ${package_name}@0.0.0 version" "$temp_dir/invocations"
      grep -Fxq "npm dist-tag ls $package_name" "$temp_dir/invocations"
    done
  fi
}

run_verify success 0 'Registry verification passed for 0.0.0.'
run_verify e404_then_success 0 'is not visible yet; waiting (1/2).'
run_verify network 1 'Unable to query @takazudo/zudo-history-stash-core@0.0.0'
network_calls=$(grep -c '^npm view ' "$temp_dir/invocations")
[[ "$network_calls" == '1' ]] || {
  printf 'network failure must fail immediately; got %s view calls\n' "$network_calls" >&2
  exit 1
}
run_verify e404_forever 1 'was not visible after 2 attempts.'
run_verify version_mismatch 1 "expected exactly '0.0.0'"
run_verify latest_wrong 1 'does not have latest: 0.0.0'
run_verify extra_next 1 "dist-tag 'next' must not point at NEXT=0.0.0"
run_verify historical 0 'historical dist-tag legacy points at 0.0.1'
run_verify dist_tag_error 1 'Unable to query dist-tags'

mismatch_dir="$temp_dir/ui-mismatch"
rsync -a --exclude='.git' --exclude='node_modules' --exclude='.wrangler' \
  --exclude='dist' "$repo_root/" "$mismatch_dir/"
node -e '
const fs = require("node:fs");
const path = process.argv[1];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.version = "9.9.9";
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
' "$mismatch_dir/packages/ui/package.json"
command_root=$mismatch_dir
run_verify success 1 'Version mismatch: packages/ui/package.json=9.9.9; expected 0.0.0.'

printf 'verify tests passed\n'
