#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: bash scripts/release.sh <check|bump|gate|tag|verify> [args]

RELEASE_TEST_MODE=1 is only for validating release tooling on a non-main branch;
it permits the --branch override (and the tag command's --skip-ci-check option).
The release skill never sets RELEASE_TEST_MODE.
USAGE
}

if [[ $# -eq 0 ]]; then
  usage
  exit 2
fi

command_name=$1
shift

case "$command_name" in
  check|bump|gate|tag|verify)
    ;;
  *)
    printf 'Unknown release command: %s\n' "$command_name" >&2
    usage
    exit 2
    ;;
esac

release_script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
release_root=$(cd "$release_script_dir/.." && pwd)
command_script="$release_script_dir/release/${command_name}.sh"

if [[ ! -f "$command_script" ]]; then
  printf 'Release command is not available in this checkout: %s\n' "$command_name" >&2
  exit 2
fi

cd "$release_root"
export RELEASE_ROOT="$release_root"

# Each command script is intentionally sourced so that the dispatcher owns the
# shell's strict mode and sibling release commands can share lib.sh state.
# shellcheck source=/dev/null
source "$command_script" "$@"
