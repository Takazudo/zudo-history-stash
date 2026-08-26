#!/usr/bin/env bash

set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$test_dir/../../.." && pwd)
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

run_case() {
  local name=$1
  local expected_status=$2
  local status_contents=$3
  local case_dir="$temp_dir/$name"
  local status_file="$case_dir/status"
  local pnpm_log="$case_dir/pnpm.log"
  local shim_dir="$case_dir/bin"
  local output actual_status

  mkdir -p "$case_dir"
  rsync -a --exclude='.git' --exclude='node_modules' --exclude='.wrangler' \
    --exclude='dist' "$repo_root/" "$case_dir/repo/"
  mkdir -p "$shim_dir"
  ln -s "$test_dir/shims/bump-git" "$shim_dir/git"
  ln -s "$test_dir/shims/bump-pnpm" "$shim_dir/pnpm"
  printf '%s' "$status_contents" >"$status_file"
  : >"$pnpm_log"

  set +e
  output=$(env \
    PATH="$shim_dir:$PATH" \
    BUMP_STATUS_FILE="$status_file" \
    BUMP_PNPM_LOG="$pnpm_log" \
    bash "$case_dir/repo/scripts/release.sh" bump 0.1.0 2>&1)
  actual_status=$?
  set -e

  if [[ "$actual_status" != "$expected_status" ]]; then
    printf '%s: expected status %s, got %s:\n%s\n' \
      "$name" "$expected_status" "$actual_status" "$output" >&2
    exit 1
  fi

  if [[ "$expected_status" == '0' ]]; then
    grep -Fxq 'openapi:generate' "$pnpm_log"
    grep -Fxq 'install' "$pnpm_log"
    grep -Fq '"version": "0.1.0"' "$case_dir/repo/packages/core/package.json"
    grep -Fq '"version": "0.1.0"' "$case_dir/repo/packages/client/package.json"
    grep -Fq '"version": "0.1.0"' "$case_dir/repo/packages/ui/package.json"
    grep -Fxq 'export const VERSION = "0.1.0";' "$case_dir/repo/packages/core/src/index.ts"
    grep -Fxq 'export const VERSION = "0.1.0";' "$case_dir/repo/packages/client/src/index.ts"
    grep -Fxq 'export const VERSION = "0.1.0";' "$case_dir/repo/packages/ui/src/index.ts"
  else
    assert_contains "$output" 'Only'
    grep -Fq '"version": "0.0.0"' "$case_dir/repo/packages/core/package.json"
    grep -Fq '"version": "0.0.0"' "$case_dir/repo/packages/client/package.json"
    grep -Fq '"version": "0.0.0"' "$case_dir/repo/packages/ui/package.json"
    grep -Fxq 'export const VERSION = "0.0.0";' "$case_dir/repo/packages/core/src/index.ts"
    grep -Fxq 'export const VERSION = "0.0.0";' "$case_dir/repo/packages/client/src/index.ts"
    grep -Fxq 'export const VERSION = "0.0.0";' "$case_dir/repo/packages/ui/src/index.ts"
  fi
}

run_case allowed 0 $' M packages/core/CHANGELOG.md\nMM packages/client/CHANGELOG.md\nM  packages/ui/CHANGELOG.md\n'
run_case staged_unrelated 1 $'M  README.md\n'
run_case modified_unrelated 1 $' M README.md\n'
run_case deleted_unrelated 1 $' D docs/api.md\n'
run_case renamed_unrelated 1 $'R  README.md -> README-copy.md\n'
run_case untracked_unrelated 1 $'?? scratch-release.txt\n'
run_case deleted_changelog 1 $' D packages/core/CHANGELOG.md\n'
run_case added_changelog 1 $'A  packages/core/CHANGELOG.md\n'
run_case conflict_changelog 1 $'UU packages/core/CHANGELOG.md\n'
run_case type_changed_changelog 1 $' T packages/core/CHANGELOG.md\n'

dry_run_output=$(bash "$repo_root/scripts/release.sh" bump 0.1.0 --dry-run)
for version_path in \
  packages/core/package.json \
  packages/client/package.json \
  packages/ui/package.json \
  packages/core/src/index.ts \
  packages/client/src/index.ts \
  packages/ui/src/index.ts; do
  [[ $(grep -Fxc "$version_path" <<<"$dry_run_output") == '1' ]] || {
    printf 'dry-run must list version path exactly once: %s\n%s\n' \
      "$version_path" "$dry_run_output" >&2
    exit 1
  }
done
[[ $(grep -Fxc 'docs/openapi.json' <<<"$dry_run_output") == '1' ]]

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
set +e
mismatch_output=$(bash "$mismatch_dir/scripts/release.sh" bump 0.1.0 --dry-run 2>&1)
mismatch_status=$?
set -e
[[ "$mismatch_status" == '1' ]]
assert_contains "$mismatch_output" \
  'Version mismatch: packages/ui/package.json=9.9.9; expected 0.0.0.'

printf 'bump tests passed\n'
