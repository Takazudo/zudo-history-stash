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

copy_repository() {
  local destination=$1
  mkdir -p "$destination"
  rsync -a --exclude='.git' --exclude='node_modules' --exclude='.wrangler' \
    --exclude='dist' --exclude='worktrees' "$repo_root/" "$destination/"
}

run_tree_case() {
  local name=$1
  local expected_status=$2
  local status_contents=$3
  local expected_diagnostic=${4:-}
  local removed_path=${5:-}
  local case_dir="$temp_dir/tree-$name"
  local repo="$case_dir/repo"
  local status_file="$case_dir/status"
  local pnpm_log="$case_dir/pnpm.log"
  local shim_dir="$case_dir/bin"
  local output actual_status

  copy_repository "$repo"
  mkdir -p "$shim_dir"
  ln -s "$test_dir/shims/bump-git" "$shim_dir/git"
  ln -s "$test_dir/shims/bump-pnpm" "$shim_dir/pnpm"
  printf '%s' "$status_contents" >"$status_file"
  : >"$pnpm_log"
  if [[ -n "$removed_path" ]]; then
    rm -f -- "$repo/$removed_path"
  fi

  set +e
  output=$(env \
    PATH="$shim_dir:$PATH" \
    BUMP_STATUS_FILE="$status_file" \
    BUMP_PNPM_LOG="$pnpm_log" \
    bash "$repo/scripts/release.sh" bump 0.1.0 2>&1)
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
    for path in \
      packages/core/package.json \
      packages/client/package.json \
      packages/ui/package.json; do
      grep -Fq '"version": "0.1.0"' "$repo/$path"
    done
    for path in \
      packages/core/src/index.ts \
      packages/client/src/index.ts \
      packages/ui/src/index.ts; do
      grep -Fxq 'export const VERSION = "0.1.0";' "$repo/$path"
    done
  else
    assert_contains "$output" "$expected_diagnostic"
    [[ ! -s "$pnpm_log" ]]
    for path in \
      packages/core/package.json \
      packages/client/package.json \
      packages/ui/package.json; do
      grep -Fq '"version": "0.0.0"' "$repo/$path"
    done
    for path in \
      packages/core/src/index.ts \
      packages/client/src/index.ts \
      packages/ui/src/index.ts; do
      grep -Fxq 'export const VERSION = "0.0.0";' "$repo/$path"
    done
  fi
}

run_tree_case clean 0 ''
run_tree_case all_allowed 0 $'?? doc/src/content/docs/changelog/core/0.1.0.mdx\nA  doc/src/content/docs/changelog/client/0.1.0.mdx\nAM doc/src/content/docs/changelog/ui/0.1.0.mdx\n M doc/src/content/docs-ja/changelog/core/0.1.0.mdx\nM  doc/src/content/docs-ja/changelog/client/0.1.0.mdx\nMM doc/src/content/docs-ja/changelog/ui/0.1.0.mdx\n M packages/core/CHANGELOG.md\nM  packages/client/CHANGELOG.md\nMM packages/ui/CHANGELOG.md\n'
run_tree_case unrelated 1 $' M README.md\n' 'disallowed path or status:  M README.md'
run_tree_case wrong_version 1 $'?? doc/src/content/docs/changelog/core/0.2.0.mdx\n' \
  'disallowed path or status: ?? doc/src/content/docs/changelog/core/0.2.0.mdx'
run_tree_case deleted_source 1 $' D doc/src/content/docs/changelog/core/0.1.0.mdx\n' \
  'disallowed path or status:  D doc/src/content/docs/changelog/core/0.1.0.mdx'
run_tree_case renamed_source 1 $'R  doc/src/content/docs/changelog/core/0.1.0.mdx -> doc/src/content/docs/changelog/core/0.1.0-old.mdx\n' \
  'disallowed path or status: R  doc/src/content/docs/changelog/core/0.1.0.mdx -> doc/src/content/docs/changelog/core/0.1.0-old.mdx'
run_tree_case conflict_source 1 $'UU doc/src/content/docs/changelog/core/0.1.0.mdx\n' \
  'disallowed path or status: UU doc/src/content/docs/changelog/core/0.1.0.mdx'
run_tree_case type_source 1 $' T doc/src/content/docs/changelog/core/0.1.0.mdx\n' \
  'disallowed path or status:  T doc/src/content/docs/changelog/core/0.1.0.mdx'
run_tree_case added_output 1 $'A  packages/core/CHANGELOG.md\n' \
  'disallowed path or status: A  packages/core/CHANGELOG.md'
run_tree_case untracked_output 1 $'?? packages/core/CHANGELOG.md\n' \
  'disallowed path or status: ?? packages/core/CHANGELOG.md'
run_tree_case missing_twin 1 '' \
  'Release changelog source is missing or is not a regular file: doc/src/content/docs-ja/changelog/ui/0.1.0.mdx' \
  'doc/src/content/docs-ja/changelog/ui/0.1.0.mdx'

snapshot_tree() {
  local root=$1
  (
    cd "$root"
    find . -path './.git' -prune -o -type f -print0 | sort -z | xargs -0 sha256sum
  )
}

mutate_heading_case() {
  local name=$1
  local root=$2
  local changelog="$root/packages/core/CHANGELOG.md"
  case "$name" in
    exact) ;;
    legacy) perl -0pi -e 's/## \[0\.1\.0\] - 2026-08-25/## 0.1.0 — 2026-08-25/' "$changelog" ;;
    missing) perl -0pi -e 's/^## \[0\.1\.0\] - 2026-08-25\n//m' "$changelog" ;;
    duplicate) perl -0pi -e 's/(## \[0\.1\.0\] - 2026-08-25)/$1\n\n$1/' "$changelog" ;;
    malformed_date) perl -0pi -e 's/2026-08-25/2026-8-25/' "$changelog" ;;
    wrong_version) perl -0pi -e 's/\[0\.1\.0\]/[0.2.0]/' "$changelog" ;;
    prefix_version) perl -0pi -e 's/\[0\.1\.0\]/[v0.1.0]/' "$changelog" ;;
    suffix_version) perl -0pi -e 's/\[0\.1\.0\]/[0.1.0beta]/' "$changelog" ;;
    extra_bracket) perl -0pi -e 's/\[0\.1\.0\]/[0.1.0]]/' "$changelog" ;;
    wrong_depth) perl -0pi -e 's/^## \[0\.1\.0\]/### [0.1.0]/m' "$changelog" ;;
    leading_space) perl -0pi -e 's/^## \[0\.1\.0\]/ ## [0.1.0]/m' "$changelog" ;;
    trailing_text) perl -0pi -e 's/2026-08-25/2026-08-25 extra/' "$changelog" ;;
    body_mention) perl -0pi -e 's/^## \[0\.1\.0\] - 2026-08-25$/The text mentions ## [0.1.0] - 2026-08-25./m' "$changelog" ;;
    crlf_heading) perl -0pi -e 's/## \[0\.1\.0\] - 2026-08-25\n/## [0.1.0] - 2026-08-25\r\n/' "$changelog" ;;
    missing_file) rm -f -- "$changelog" ;;
    lockstep_mismatch)
      node -e '
const fs = require("node:fs");
const path = process.argv[1];
const value = JSON.parse(fs.readFileSync(path, "utf8"));
value.version = "9.9.9";
fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
' "$root/packages/ui/package.json"
      ;;
    *) printf 'unknown heading fixture: %s\n' "$name" >&2; exit 1 ;;
  esac
}

run_dry_case() {
  local name=$1
  local expected_status=$2
  local expected_diagnostic=${3:-}
  local case_dir="$temp_dir/dry-$name"
  local repo="$case_dir/repo"
  local shim_dir="$case_dir/bin"
  local writer_log="$case_dir/writer.log"
  local before_hashes after_hashes before_status after_status output actual_status

  copy_repository "$repo"
  mutate_heading_case "$name" "$repo"
  (
    cd "$repo"
    git init -q
    git config user.email release-test@example.invalid
    git config user.name 'Release Test'
    git add .
    git commit -qm fixture
  )
  mkdir -p "$shim_dir"
  for command in git pnpm cp mv; do
    ln -s "$test_dir/shims/dry-run-command" "$shim_dir/$command"
  done
  : >"$writer_log"
  before_hashes=$(snapshot_tree "$repo")
  before_status=$(git -C "$repo" status --porcelain=v1 --untracked-files=all)

  set +e
  output=$(env \
    PATH="$shim_dir:$PATH" \
    RELEASE_ROOT="$repo" \
    DRY_RUN_COMMAND_LOG="$writer_log" \
    bash "$repo/scripts/release.sh" bump 0.1.0 --dry-run 2>&1)
  actual_status=$?
  set -e

  after_hashes=$(snapshot_tree "$repo")
  after_status=$(git -C "$repo" status --porcelain=v1 --untracked-files=all)
  [[ "$actual_status" == "$expected_status" ]] || {
    printf '%s: expected dry-run status %s, got %s:\n%s\n' "$name" "$expected_status" "$actual_status" "$output" >&2
    exit 1
  }
  [[ "$before_hashes" == "$after_hashes" ]]
  [[ "$before_status" == "$after_status" ]]
  [[ ! -s "$writer_log" ]]

  if [[ "$expected_status" == '0' ]]; then
    assert_contains "$output" 'NEXT=0.1.0'
    mapfile -t expected < <(
      RELEASE_ROOT="$repo" bash -c 'source "$1/scripts/release/lib.sh"; release_atomic_commit_paths_for_version 0.1.0' _ "$repo"
    )
    for path in "${expected[@]}"; do
      [[ $(grep -Fxc "$path" <<<"$output") == '1' ]] || {
        printf 'dry-run must list exact atomic path once: %s\n%s\n' "$path" "$output" >&2
        exit 1
      }
    done
    [[ ${#expected[@]} == 16 ]]
  else
    if [[ -n "$expected_diagnostic" ]]; then
      assert_contains "$output" "$expected_diagnostic"
    else
      assert_contains "$output" "packages/core/CHANGELOG.md must contain exactly one '## [0.1.0] - YYYY-MM-DD' heading"
    fi
  fi
}

run_dry_case exact 0
for heading_case in \
  legacy missing duplicate malformed_date wrong_version prefix_version suffix_version extra_bracket \
  wrong_depth leading_space trailing_text body_mention crlf_heading missing_file; do
  run_dry_case "$heading_case" 1
done
run_dry_case lockstep_mismatch 1 \
  'Version mismatch: packages/ui/package.json=9.9.9; expected 0.0.0.'

printf 'bump tests passed\n'
