#!/usr/bin/env bash

set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$test_dir/../../.." && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
shim_dir="$temp_dir/bin"
mkdir -p "$shim_dir"
ln -s "$test_dir/shims/gate-pnpm" "$shim_dir/pnpm"

run_gate() {
  local name=$1
  local drift_status=${2:-}
  local case_dir="$temp_dir/$name"
  local command_log="$case_dir/commands.log"
  local tmp_root="$case_dir/tmp"
  local output status
  mkdir -p "$case_dir" "$tmp_root"
  : >"$command_log"
  set +e
  output=$(env \
    PATH="$shim_dir:$PATH" \
    RELEASE_ROOT="$repo_root" \
    TMPDIR="$tmp_root" \
    GATE_COMMAND_LOG="$command_log" \
    GATE_SHIM_ROOT="$case_dir" \
    GATE_DRIFT_STATUS="$drift_status" \
    bash "$repo_root/scripts/release.sh" gate 2>&1)
  status=$?
  set -e
  printf '%s\n' "$status" >"$case_dir/status"
  printf '%s\n' "$output" >"$case_dir/output"
}

run_gate drift_failure 73
[[ $(<"$temp_dir/drift_failure/status") == '73' ]]
grep -Fxq 'GATE_DRIFT_FAILURE_SENTINEL' "$temp_dir/drift_failure/output"
[[ $(wc -l <"$temp_dir/drift_failure/commands.log") == '1' ]]
grep -Fxq drift "$temp_dir/drift_failure/commands.log"
[[ -z $(find "$temp_dir/drift_failure/tmp" -mindepth 1 -print -quit) ]]
if grep -Eq 'build|pack|lint|init|add|publish' "$temp_dir/drift_failure/commands.log"; then
  printf 'release gate continued after changelog drift failure\n' >&2
  exit 1
fi

run_gate green
[[ $(<"$temp_dir/green/status") == '0' ]] || {
  cat "$temp_dir/green/output" >&2
  exit 1
}
expected_log=$(cat <<'LOG'
drift
build:libs
pack:core
lint:core
pack:client
lint:client
pack:ui
lint:ui
init
add
publish:core-fixture.tgz
publish:client-fixture.tgz
publish:ui-fixture.tgz
LOG
)
[[ $(<"$temp_dir/green/commands.log") == "$expected_log" ]]
grep -Fq 'Release packaging gate passed for 0.0.0.' "$temp_dir/green/output"
[[ -z $(find "$temp_dir/green/tmp" -mindepth 1 -print -quit) ]]

printf 'gate tests passed\n'
