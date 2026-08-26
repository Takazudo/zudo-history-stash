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

node - "$repo_root/scripts/release/gate.sh" \
  "$repo_root/scripts/release/package-check.mjs" \
  "$repo_root/packages/core/package.json" \
  "$repo_root/packages/client/package.json" \
  "$repo_root/packages/ui/package.json" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");

const [gatePath, packageCheckPath, ...packagePaths] = process.argv.slice(2);
const gate = fs.readFileSync(gatePath, "utf8");
const packageCheck = fs.readFileSync(packageCheckPath, "utf8");
const packIndex = gate.indexOf('pnpm pack --pack-destination "$destination"');
const checkIndex = gate.indexOf('pnpm run lint:pkg -- "$tarball"');
assert.ok(packIndex >= 0, "release gate must pack each artifact");
assert.ok(checkIndex > packIndex, "release gate must check the artifact it just packed");
assert.match(
  gate,
  /pnpm --store-dir "\$gate_tmp\/pnpm-store" add/u,
  "release gate smoke install must use its disposable store",
);

for (const packagePath of packagePaths) {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  assert.equal(
    packageJson.scripts?.["lint:pkg"],
    "node ../../scripts/release/package-check.mjs",
    `${packagePath} must use the shared packed-artifact package check`,
  );
}
assert.match(packageCheck, /publint@0\.3\.12/u);
assert.match(packageCheck, /@arethetypeswrong\/cli@0\.18\.5/u);
assert.match(packageCheck, /"run", tarballPath, "--pack=false"/u);
assert.match(packageCheck, /tarballPath,\n\s+"--profile",\n\s+"esm-only"/u);
assert.doesNotMatch(packageCheck, /--pack \./u);
NODE

printf 'release contract tests passed\n'
