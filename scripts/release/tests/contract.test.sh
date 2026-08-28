#!/usr/bin/env bash

set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$test_dir/../../.." && pwd)
# The sourced library consumes this root.
# shellcheck disable=SC2034
RELEASE_ROOT="$repo_root"
# shellcheck source=../lib.sh
source "$repo_root/scripts/release/lib.sh"

fixture_version='1.2.3'
expected_paths=(
  'packages/core/package.json'
  'packages/client/package.json'
  'packages/ui/package.json'
  'packages/core/src/index.ts'
  'packages/client/src/index.ts'
  'packages/ui/src/index.ts'
  "doc/src/content/docs/changelog/core/$fixture_version.mdx"
  "doc/src/content/docs/changelog/client/$fixture_version.mdx"
  "doc/src/content/docs/changelog/ui/$fixture_version.mdx"
  "doc/src/content/docs-ja/changelog/core/$fixture_version.mdx"
  "doc/src/content/docs-ja/changelog/client/$fixture_version.mdx"
  "doc/src/content/docs-ja/changelog/ui/$fixture_version.mdx"
  'packages/core/CHANGELOG.md'
  'packages/client/CHANGELOG.md'
  'packages/ui/CHANGELOG.md'
  'docs/openapi.json'
)

mapfile -t atomic_paths < <(release_atomic_commit_paths_for_version "$fixture_version")
[[ ${#atomic_paths[@]} == 16 ]]
[[ "$(printf '%s\n' "${atomic_paths[@]}")" == \
  "$(printf '%s\n' "${expected_paths[@]}")" ]]
for helper in release_changelog_source_paths_for_version release_atomic_commit_paths_for_version; do
  invalid_output=$(mktemp)
  if "$helper" '1.2.3beta' >"$invalid_output" 2>/dev/null; then
    printf '%s accepted a non-plain-SemVer version\n' "$helper" >&2
    exit 1
  fi
  [[ ! -s "$invalid_output" ]]
  rm -f -- "$invalid_output"
done

skill="$repo_root/.claude/skills/l-make-release/SKILL.md"
for path in "${expected_paths[@]}"; do
  grep -Fq "${path/$fixture_version/\$VERSION}" "$skill"
done
grep -Fq 'Stage exactly these sixteen paths' "$skill"
grep -Fq '(sixteen paths total)' "$skill"
node - "$skill" "$fixture_version" "${expected_paths[@]}" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");

const [skillPath, version, ...expectedPaths] = process.argv.slice(2);
const contents = fs.readFileSync(skillPath, "utf8");
const command = contents.match(/^\s*git add ([\s\S]*?)^\s*git commit /mu);
assert.ok(command, "release skill must contain one staged-path command before its commit");
const stagedPaths = command[1]
  .replace(/\\\r?\n/gu, " ")
  .trim()
  .split(/\s+/u)
  .map((path) => path.replaceAll("$VERSION", version));
assert.deepEqual(stagedPaths, expectedPaths);
NODE

node - "$skill" "$repo_root/scripts/release/gate.sh" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");

const [skillPath, gatePath] = process.argv.slice(2);
const skill = fs.readFileSync(skillPath, "utf8");
const gate = fs.readFileSync(gatePath, "utf8");
const docsBuild = skill.indexOf("pnpm build:doc");
const bump = skill.indexOf('pnpm release:bump "$MODE"');
assert.ok(docsBuild >= 0 && docsBuild < bump, "release skill must build generated changelogs before bump");
assert.match(skill, /pnpm release:gate[\s\S]*pnpm format:check[\s\S]*pnpm format:md:check/u);
assert.doesNotMatch(skill, /## \$VERSION —/u);
assert.match(skill, /awk -v heading="## \[\$VERSION\] - "/u);
assert.match(skill, /if \(\$0 ~ \/\[\^\[:space:\]\]\/[\s\S]*has_content/u);

const drift = gate.indexOf("pnpm --filter zudo-history-stash-doc check:changelog-drift");
const temp = gate.indexOf("gate_tmp=$(mktemp");
const build = gate.indexOf("pnpm build:libs");
assert.ok(drift > gate.indexOf('cd "$RELEASE_ROOT"'));
assert.ok(drift < temp && drift < build, "drift check must be the first gate action");
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
assert.match(gate, /pnpm add "\$core_tarball" "\$client_tarball" "\$ui_tarball"/u);
assert.doesNotMatch(gate, /pnpm --store-dir/u, "release gate must use the default pnpm store");

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

const publishStart = gate.indexOf("publish_package() {");
assert.ok(publishStart >= 0, "release gate must define a packed-tarball publish helper");
const publishBlock = gate.slice(publishStart);
assert.match(publishBlock, /pnpm publish "\$tarball" --dry-run --no-git-checks/u);
for (const [packageVariable, tarballVariable] of [
  ["core_package_name", "core_tarball"],
  ["client_package_name", "client_tarball"],
  ["ui_package_name", "ui_tarball"],
]) {
  assert.match(
    publishBlock,
    new RegExp(`publish_package "\\$${packageVariable}" "\\$${tarballVariable}"`, "u"),
  );
}
assert.doesNotMatch(publishBlock, /cd "\$\w+_package_dir"/u);
NODE

printf 'release contract tests passed\n'
