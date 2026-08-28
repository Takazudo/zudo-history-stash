#!/usr/bin/env bash

set -euo pipefail

if (( $# != 1 )); then
  echo "usage: $0 <git-ref>" >&2
  exit 1
fi

ref="$1"
if [[ "$ref" =~ ^refs/tags/v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  printf '%s.%s.%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
  exit 0
fi

exit 1
