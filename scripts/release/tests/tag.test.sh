#!/usr/bin/env bash
set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$test_dir/../../.." && pwd)
shim_dir="$test_dir/shims"
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

assert_contains() {
  local output=$1
  local expected=$2
  if [[ "$output" != *"$expected"* ]]; then
    printf 'expected output to contain %q, got:\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

run_tag() {
  local expected_status=$1
  local expected_message=$2
  shift 2
  rm -rf "$temp_dir/state"
  mkdir -p "$temp_dir/state"
  : >"$temp_dir/invocations"
  local output actual_status
  set +e
  output=$(env \
    PATH="$shim_dir:$PATH" \
    RELEASE_TEST_MODE=1 \
    RELEASE_TAG_CI_MAX_ATTEMPTS=2 \
    RELEASE_TAG_CI_POLL_SECONDS=0 \
    RELEASE_SHIM_LOG="$temp_dir/invocations" \
    RELEASE_SHIM_STATE_DIR="$temp_dir/state" \
    "$@" \
    bash "$repo_root/scripts/release.sh" tag --dry-run --branch base/sweep-260826-release 2>&1)
  actual_status=$?
  set -e
  if [[ "$actual_status" != "$expected_status" ]]; then
    printf 'expected status %s, got %s:\n%s\n' "$expected_status" "$actual_status" "$output" >&2
    exit 1
  fi
  assert_contains "$output" "$expected_message"
  if grep -Eq '^git (tag v|push )' "$temp_dir/invocations"; then
    printf 'dry-run leaked a tag or push mutation:\n' >&2
    sed -n '1,120p' "$temp_dir/invocations" >&2
    exit 1
  fi
  grep -Fxq 'git fetch --tags origin' "$temp_dir/invocations"
}

run_tag 0 'git tag v0.0.0 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
run_tag 0 'git push origin v0.0.0' GH_SCENARIO=deterministic
run_tag 0 'CI run 101 succeeded' GH_SCENARIO=queued_then_success
run_tag 1 'Working tree must be clean' GIT_DIRTY=1
run_tag 1 "must run on branch 'base/sweep-260826-release'" GIT_BRANCH=wrong-branch
run_tag 1 'must exactly match origin/base/sweep-260826-release' \
  GIT_ORIGIN_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
run_tag 1 'already exists locally' GIT_LOCAL_TAG=1
run_tag 1 'already exists on origin' GIT_REMOTE_TAG=1
run_tag 1 "concluded 'failure', not success" GH_SCENARIO=failure
run_tag 1 'No successful CI run became available' GH_SCENARIO=no_run
run_tag 1 'Unable to query CI runs' GH_SCENARIO=query_error

# The CI bypass is accepted only in test mode and still performs every other
# precondition.
rm -rf "$temp_dir/state"
mkdir -p "$temp_dir/state"
: >"$temp_dir/invocations"
skip_output=$(env PATH="$shim_dir:$PATH" RELEASE_TEST_MODE=1 \
  RELEASE_SHIM_LOG="$temp_dir/invocations" RELEASE_SHIM_STATE_DIR="$temp_dir/state" \
  bash "$repo_root/scripts/release.sh" tag --dry-run --branch base/sweep-260826-release \
  --skip-ci-check 2>&1)
assert_contains "$skip_output" 'Skipping CI check in RELEASE_TEST_MODE.'
if grep -q '^gh ' "$temp_dir/invocations"; then
  printf 'skip-ci-check unexpectedly queried gh\n' >&2
  exit 1
fi

set +e
guard_output=$(bash "$repo_root/scripts/release.sh" tag --dry-run --branch main 2>&1)
guard_status=$?
set -e
[[ "$guard_status" == '2' ]]
assert_contains "$guard_output" '--branch is available only when RELEASE_TEST_MODE=1.'

set +e
mutation_guard_output=$(env RELEASE_TEST_MODE=1 \
  bash "$repo_root/scripts/release.sh" tag --branch base/sweep-260826-release --skip-ci-check 2>&1)
mutation_guard_status=$?
set -e
[[ "$mutation_guard_status" == '2' ]]
assert_contains "$mutation_guard_output" 'Test-only branch and CI overrides require --dry-run.'

printf 'tag tests passed\n'
