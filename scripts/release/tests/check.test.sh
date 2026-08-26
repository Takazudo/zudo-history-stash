#!/usr/bin/env bash

set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$test_dir/../../.." && pwd)

output=$(bash "$repo_root/scripts/release.sh" check -- --help 2>&1)
[[ "$output" == *'Usage: bash scripts/release.sh check [--branch BRANCH]'* ]]

printf 'check tests passed\n'
