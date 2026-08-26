#!/usr/bin/env bash

set -euo pipefail

test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$test_dir/../../.." && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf -- "$temp_dir"' EXIT

shim_dir="$temp_dir/bin"
log_file="$temp_dir/invocations"
mkdir -p "$shim_dir"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'printf "%s\\n" "$*" >>"$PACKAGE_CHECK_LOG"' >"$shim_dir/pnpm"
chmod +x "$shim_dir/pnpm"

tarball="$temp_dir/core.tgz"
: >"$tarball"
(
  cd "$repo_root/packages/core"
  env PATH="$shim_dir:$PATH" PACKAGE_CHECK_LOG="$log_file" \
    node ../../scripts/release/package-check.mjs "$tarball"
)

grep -Fq "dlx publint@0.3.12 run $tarball --pack=false" "$log_file"
grep -Fq "dlx @arethetypeswrong/cli@0.18.5 $tarball --profile esm-only" "$log_file"
if grep -Eq '(^| )pack( |$)' "$log_file"; then
  printf 'prepacked package check unexpectedly repacked the artifact:\n' >&2
  cat "$log_file" >&2
  exit 1
fi

printf 'package-check tests passed\n'
