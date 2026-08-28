#!/usr/bin/env bash
set -euo pipefail

release_command_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$release_command_dir/lib.sh"

if [[ $# -ne 0 ]]; then
  release_usage_error 'Usage: bash scripts/release.sh verify'
fi

if ! next=$(release_lockstep_version); then
  exit 1
fi
# `plain_semver_re` is assigned by the sourced lib.sh.
# shellcheck disable=SC2154
if [[ ! "$next" =~ $plain_semver_re ]]; then
  release_error "NEXT=$next violates the plain SemVer rule $plain_semver_re."
  exit 1
fi
openapi_version=$(release_openapi_version)
if [[ "$openapi_version" != "$next" ]]; then
  release_error "docs/openapi.json has info.version $openapi_version; expected $next."
  exit 1
fi

verify_max_attempts=30
verify_poll_seconds=10
if [[ "${RELEASE_TEST_MODE:-}" == '1' ]]; then
  verify_max_attempts=${RELEASE_VERIFY_MAX_ATTEMPTS:-$verify_max_attempts}
  verify_poll_seconds=${RELEASE_VERIFY_POLL_SECONDS:-$verify_poll_seconds}
fi
if [[ ! "$verify_max_attempts" =~ ^[1-9][0-9]*$ || ! "$verify_poll_seconds" =~ ^[0-9]+$ ]]; then
  release_error 'Test retry overrides must be non-negative integers with at least one attempt.'
  exit 2
fi

# `release_package_names` is assigned by the sourced lib.sh.
# shellcheck disable=SC2154
for package_name in "${release_package_names[@]}"; do
  published=0
  for ((attempt = 1; attempt <= verify_max_attempts; attempt++)); do
    if output=$(npm view "$package_name@$next" version 2>&1); then
      if [[ "$output" != "$next" ]]; then
        release_error "npm returned version '$output' for $package_name@$next; expected exactly '$next'."
        exit 1
      fi
      printf 'Verified %s@%s.\n' "$package_name" "$next"
      published=1
      break
    fi

    if grep -Eq '^npm (ERR!|error) code E404([[:space:]]|$)' <<<"$output"; then
      printf '%s@%s is not visible yet; waiting (%d/%d).\n' \
        "$package_name" "$next" "$attempt" "$verify_max_attempts"
      if ((attempt < verify_max_attempts)); then
        sleep "$verify_poll_seconds"
      fi
      continue
    fi

    release_error "Unable to query $package_name@$next: $output"
    exit 1
  done
  if ((!published)); then
    release_error "$package_name@$next was not visible after $verify_max_attempts attempts."
    exit 1
  fi

  if ! tags=$(npm dist-tag ls "$package_name" 2>&1); then
    release_error "Unable to query dist-tags for $package_name: $tags"
    exit 1
  fi
  if ! grep -Fxq "latest: $next" <<<"$tags"; then
    release_error "$package_name does not have latest: $next (tags: $tags)"
    exit 1
  fi

  while IFS= read -r tag_line; do
    [[ -n "$tag_line" ]] || continue
    tag_name=${tag_line%%:*}
    tag_version=${tag_line#*: }
    if [[ "$tag_line" != *': '* ]]; then
      release_error "Malformed dist-tag output for $package_name: $tag_line"
      exit 1
    fi
    if [[ "$tag_name" != 'latest' && "$tag_version" == "$next" ]]; then
      release_error "$package_name dist-tag '$tag_name' must not point at NEXT=$next."
      exit 1
    fi
    if [[ "$tag_name" != 'latest' && "$tag_version" != "$next" ]]; then
      printf '::warning::%s historical dist-tag %s points at %s.\n' \
        "$package_name" "$tag_name" "$tag_version" >&2
    fi
  done <<<"$tags"
done

printf 'Registry verification passed for %s.\n' "$next"
