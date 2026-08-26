#!/usr/bin/env bash
set -euo pipefail

# Shared by command scripts that source this file.
# shellcheck disable=SC2034
plain_semver_re='^[0-9]+\.[0-9]+\.[0-9]+$'

if [[ -z "${RELEASE_ROOT:-}" ]]; then
  RELEASE_ROOT=$(git rev-parse --show-toplevel)
fi

# These arrays are consumed by sibling scripts after sourcing this library.
# shellcheck disable=SC2034
release_package_manifest_paths=(
  'packages/core/package.json'
  'packages/client/package.json'
  'packages/ui/package.json'
)
# shellcheck disable=SC2034
release_version_source_paths=(
  'packages/core/src/index.ts'
  'packages/client/src/index.ts'
  'packages/ui/src/index.ts'
)
# shellcheck disable=SC2034
release_changelog_paths=(
  'packages/core/CHANGELOG.md'
  'packages/client/CHANGELOG.md'
  'packages/ui/CHANGELOG.md'
)
# shellcheck disable=SC2034
release_package_names=(
  '@takazudo/zudo-history-stash-core'
  '@takazudo/zudo-history-stash'
  '@takazudo/zudo-history-stash-ui'
)
# shellcheck disable=SC2034
release_atomic_commit_paths=(
  "${release_package_manifest_paths[@]}"
  "${release_version_source_paths[@]}"
  "${release_changelog_paths[@]}"
  'docs/openapi.json'
)

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

release_lockstep_version() {
  local expected
  local path
  local value

  expected=$(current_version)
  for path in "${release_package_manifest_paths[@]}"; do
    if ! value=$(release_package_version "$RELEASE_ROOT/$path"); then
      release_error "Could not read the package version from $path."
      return 1
    fi
    if [[ "$value" != "$expected" ]]; then
      release_error "Version mismatch: $path=$value; expected $expected."
      return 1
    fi
  done
  for path in "${release_version_source_paths[@]}"; do
    if ! value=$(release_version_constant "$RELEASE_ROOT/$path"); then
      release_error "Could not read exactly one VERSION constant from $path."
      return 1
    fi
    if [[ "$value" != "$expected" ]]; then
      release_error "Version mismatch: $path=$value; expected $expected."
      return 1
    fi
  done
  printf '%s\n' "$expected"
}

release_version_constant() {
  local source_file=$1
  node -e '
const fs = require("node:fs");
const sourceFile = process.argv[1];
const source = fs.readFileSync(sourceFile, "utf8");
const matches = [...source.matchAll(/^export const VERSION = "([^"\r\n]+)";$/gm)];
if (matches.length !== 1) {
  throw new Error(`Expected exactly one VERSION constant in ${sourceFile}`);
}
process.stdout.write(matches[0][1]);
  ' "$source_file"
}

release_openapi_version() {
  node - "$RELEASE_ROOT/docs/openapi.json" <<'NODE'
const fs = require("node:fs");

const [documentPath] = process.argv.slice(2);
const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
if (typeof document.info?.version !== "string") {
  throw new Error(`OpenAPI document ${documentPath} is missing info.version`);
}
process.stdout.write(document.info.version);
NODE
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

# The release skill edits all three changelogs before invoking `release:bump`. Keep
# the guard strict for every other path (including staged, deleted, renamed,
# copied, and untracked entries), while allowing the three intended changelog
# edits in either the index or the worktree.
require_bump_tree() {
  local changes
  local line
  local status
  local path
  local allowed_changelog
  local changelog_path

  changes=$(git status --porcelain=v1 --untracked-files=all)
  [[ -n "$changes" ]] || return 0

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if [[ ${#line} -lt 4 ]]; then
      release_error 'Working tree has an unrecognised status entry; release bump stopped.'
      printf '%s\n' "$changes" >&2
      return 1
    fi

    status=${line:0:2}
    path=${line:3}
    case "$status" in
      ' M'|'M '|'MM')
        ;;
      *)
        release_error 'Only modified release changelogs may be changed before a release bump.'
        printf '%s\n' "$changes" >&2
        return 1
        ;;
    esac

    allowed_changelog=0
    for changelog_path in "${release_changelog_paths[@]}"; do
      if [[ "$path" == "$changelog_path" ]]; then
        allowed_changelog=1
        break
      fi
    done
    if ((!allowed_changelog)); then
      release_error 'Only package changelogs may be changed before a release bump.'
      printf '%s\n' "$changes" >&2
      return 1
    fi
  done <<<"$changes"
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
