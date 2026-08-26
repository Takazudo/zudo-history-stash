#!/usr/bin/env bash

set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$test_dir/../../.." && pwd)
# The sourced library consumes this root.
# shellcheck disable=SC2034
RELEASE_ROOT="$repo_root"
# shellcheck source=../lib.sh
source "$repo_root/scripts/release/lib.sh"

expected_paths=(
  'packages/core/package.json'
  'packages/client/package.json'
  'packages/ui/package.json'
  'packages/core/src/index.ts'
  'packages/client/src/index.ts'
  'packages/ui/src/index.ts'
  'packages/core/CHANGELOG.md'
  'packages/client/CHANGELOG.md'
  'packages/ui/CHANGELOG.md'
  'docs/openapi.json'
)

# `release_atomic_commit_paths` is assigned by the sourced lib.sh.
# shellcheck disable=SC2154
[[ ${#release_atomic_commit_paths[@]} == 10 ]]
[[ "$(printf '%s\n' "${release_atomic_commit_paths[@]}")" == \
  "$(printf '%s\n' "${expected_paths[@]}")" ]]

skill="$repo_root/.claude/skills/l-make-release/SKILL.md"
for path in "${expected_paths[@]}"; do
  grep -Fq "$path" "$skill"
done
grep -Fq 'Stage exactly these ten paths' "$skill"
grep -Fq '(ten paths total)' "$skill"
node - "$skill" "${expected_paths[@]}" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");

const [skillPath, ...expectedPaths] = process.argv.slice(2);
const contents = fs.readFileSync(skillPath, "utf8");
const command = contents.match(/^\s*git add ([\s\S]*?)^\s*git commit /mu);
assert.ok(command, "release skill must contain one staged-path command before its commit");
const stagedPaths = command[1].replace(/\\\r?\n/gu, " ").trim().split(/\s+/u);
assert.deepEqual(stagedPaths, expectedPaths);
NODE

printf 'release contract tests passed\n'
