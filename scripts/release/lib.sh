#!/usr/bin/env bash
set -euo pipefail

plain_semver_re='^[0-9]+\.[0-9]+\.[0-9]+$'

if [[ -z "${RELEASE_ROOT:-}" ]]; then
  RELEASE_ROOT=$(git rev-parse --show-toplevel)
fi

release_error() {
  printf '::error::%s\n' "$*" >&2
}

release_usage_error() {
  printf '%s\n' "$*" >&2
  exit 2
}

release_package_version() {
  local package_file=$1
  node -e '
const fs = require("node:fs");
const packageFile = process.argv[1];
const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
if (typeof packageJson.version !== "string") {
  throw new Error(`Missing version in ${packageFile}`);
}
process.stdout.write(packageJson.version);
' "$package_file"
}

current_version() {
  release_package_version "$RELEASE_ROOT/packages/core/package.json"
}

release_version_constant() {
  local source_file=$1
  node -e '
const fs = require("node:fs");
const sourceFile = process.argv[1];
const source = fs.readFileSync(sourceFile, "utf8");
const matches = [...source.matchAll(/^export const VERSION = "([^"\\r\\n]+)";$/gm)];
if (matches.length !== 1) {
  throw new Error(`Expected exactly one VERSION constant in ${sourceFile}`);
}
process.stdout.write(matches[0][1]);
' "$source_file"
}

require_clean_tree() {
  local changes
  changes=$(git status --porcelain=v1 --untracked-files=all)
  if [[ -n "$changes" ]]; then
    release_error "Working tree must be clean before a release operation."
    printf '%s\n' "$changes" >&2
    return 1
  fi
}

require_branch() {
  local expected=${1:-main}
  local actual
  actual=$(git branch --show-current)
  if [[ "$actual" != "$expected" ]]; then
    release_error "Release command must run on branch '$expected' (current: '${actual:-detached}')."
    return 1
  fi
}

release_semver_greater() {
  local left=$1
  local right=$2
  local left_major left_minor left_patch
  local right_major right_minor right_patch

  IFS=. read -r left_major left_minor left_patch <<<"$left"
  IFS=. read -r right_major right_minor right_patch <<<"$right"

  if ((10#$left_major > 10#$right_major)); then
    return 0
  fi
  if ((10#$left_major < 10#$right_major)); then
    return 1
  fi
  if ((10#$left_minor > 10#$right_minor)); then
    return 0
  fi
  if ((10#$left_minor < 10#$right_minor)); then
    return 1
  fi
  ((10#$left_patch > 10#$right_patch))
}

release_changelog_heading_count() {
  local changelog=$1
  local version=$2

  if [[ ! -f "$changelog" ]]; then
    printf '0\n'
    return 0
  fi

  awk -v version="$version" '
    BEGIN { delimiter = " — " }
    /^## / {
      heading = substr($0, 4)
      separator = index(heading, delimiter)
      if (separator == 0) next
      heading_version = substr(heading, 1, separator - 1)
      date = substr(heading, separator + length(delimiter))
      if (heading_version == version && date ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) count++
    }
    END { print count + 0 }
  ' "$changelog"
}
