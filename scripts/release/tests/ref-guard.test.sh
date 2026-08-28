#!/usr/bin/env bash

set -euo pipefail

test_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
guard="$test_dir/../ref-guard.sh"

assert_status() {
  local expected="$1"
  local ref="${2-}"
  local actual

  if (( $# == 1 )); then
    if "$guard" >/dev/null 2>&1; then
      actual=0
    else
      actual=$?
    fi
  elif "$guard" "$ref" >/dev/null 2>&1; then
    actual=0
  else
    actual=$?
  fi
  if [[ "$actual" != "$expected" ]]; then
    echo "expected ref-guard.sh $ref to exit $expected, got $actual" >&2
    exit 1
  fi
}

assert_version() {
  local ref="$1"
  local expected="$2"
  local actual
  actual="$("$guard" "$ref")"
  if [[ "$actual" != "$expected" ]]; then
    echo "expected ref-guard.sh $ref to print $expected, got $actual" >&2
    exit 1
  fi
}

assert_status 0 refs/tags/v0.1.0
assert_version refs/tags/v1.23.456 1.23.456
assert_status 1 refs/tags/v0.1.0-next.1
assert_status 1 refs/tags/v0.1.0+build.1
assert_status 1 refs/heads/main
assert_status 1 refs/tags/v1.2
assert_status 1 refs/tags/v1.2.3.4
assert_status 1

echo "ref-guard tests passed"
