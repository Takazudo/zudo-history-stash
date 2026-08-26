#!/usr/bin/env bash

set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$test_dir/../../.." && pwd)

node - "$repo_root/.github/workflows/release.yml" <<'NODE'
const fs = require("node:fs");

const [workflowPath] = process.argv.slice(2);
const workflow = fs.readFileSync(workflowPath, "utf8");
const orderedSteps = [
  "- name: Publish core",
  "- name: Verify core publication",
  "- name: Publish client",
  "- name: Verify client publication",
  "- name: Publish UI",
  "- name: Verify UI publication",
  "- name: Verify dist-tags",
];
let previous = -1;
for (const step of orderedSteps) {
  const index = workflow.indexOf(step);
  if (index <= previous) throw new Error(`Release step is missing or out of order: ${step}`);
  previous = index;
}
for (const required of [
  "packages/ui/package.json",
  "packages/ui/src/index.ts",
  "@takazudo/zudo-history-stash-ui",
  "ui_already_published",
]) {
  if (!workflow.includes(required)) throw new Error(`Workflow is missing ${required}`);
}
const exactLookupCount = [...workflow.matchAll(/npm view "\$\{PACKAGE_NAME\}@\$\{VERSION\}" version/gu)]
  .length;
if (exactLookupCount !== 3) {
  throw new Error(`Expected three exact-version publication polls, found ${exactLookupCount}`);
}
NODE

printf 'release workflow tests passed\n'
