#!/usr/bin/env bash
set -euo pipefail

release_command_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$release_command_dir/lib.sh"

usage() {
  cat >&2 <<'USAGE'
Usage: bash scripts/release.sh bump <major|minor|patch|X.Y.Z> [--dry-run]
USAGE
}

requested=''
dry_run=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        if [[ -n "$requested" ]]; then
          usage
          release_usage_error 'Only one bump mode or version may be supplied'
        fi
        requested=$1
        shift
      done
      ;;
    -*)
      usage
      release_usage_error "Unknown bump argument: $1"
      ;;
    *)
      if [[ -n "$requested" ]]; then
        usage
        release_usage_error 'Only one bump mode or version may be supplied'
      fi
      requested=$1
      shift
      ;;
  esac
done

if [[ -z "$requested" ]]; then
  usage
  exit 2
fi

if ! current=$(release_lockstep_version); then
  exit 1
fi

# `plain_semver_re` is assigned by the sourced lib.sh.
# shellcheck disable=SC2154
if [[ ! "$current" =~ $plain_semver_re ]]; then
  release_error "Current version '$current' does not match the plain SemVer rule $plain_semver_re."
  exit 1
fi

case "$requested" in
  major)
    IFS=. read -r current_major current_minor current_patch <<<"$current"
    next="$((10#$current_major + 1)).0.0"
    ;;
  minor)
    IFS=. read -r current_major current_minor current_patch <<<"$current"
    next="$current_major.$((10#$current_minor + 1)).0"
    ;;
  patch)
    IFS=. read -r current_major current_minor current_patch <<<"$current"
    next="$current_major.$current_minor.$((10#$current_patch + 1))"
    ;;
  next|stable)
    release_error "Unknown bump mode '$requested'; use major, minor, patch, or an explicit X.Y.Z."
    exit 2
    ;;
  *)
    if [[ "$requested" == *.* || "$requested" == *-* || "$requested" == *+* || "$requested" =~ ^[0-9] ]]; then
      next=$requested
    else
      release_error "Unknown bump mode '$requested'; use major, minor, patch, or an explicit X.Y.Z."
      exit 2
    fi
    ;;
esac

# `plain_semver_re` is assigned by the sourced lib.sh.
# shellcheck disable=SC2154
if [[ ! "$next" =~ $plain_semver_re ]]; then
  release_error "NEXT=$next violates the plain SemVer rule $plain_semver_re; prerelease and build metadata are not allowed."
  exit 1
fi

if ! release_semver_greater "$next" "$current"; then
  release_error "NEXT=$next must be strictly greater than current version $current."
  exit 1
fi

# `release_changelog_paths` is assigned by the sourced lib.sh.
# shellcheck disable=SC2154
for changelog_path in "${release_changelog_paths[@]}"; do
  changelog="$RELEASE_ROOT/$changelog_path"
  heading_count=$(release_changelog_heading_count "$changelog" "$next")
  if [[ "$heading_count" != '1' ]]; then
    relative_changelog=${changelog#"$RELEASE_ROOT/"}
    release_error "$relative_changelog must contain exactly one '## [$next] - YYYY-MM-DD' heading (found $heading_count)."
    exit 1
  fi
done

mapfile -t atomic_paths < <(release_atomic_commit_paths_for_version "$next")

if ((dry_run)); then
  printf 'NEXT=%s\n' "$next"
  printf '%s\n' "${atomic_paths[@]}"
  exit 0
fi

require_bump_tree "$next"

# `release_package_manifest_paths` is assigned by the sourced lib.sh.
# shellcheck disable=SC2154
for package_path in "${release_package_manifest_paths[@]}"; do
  package_file="$RELEASE_ROOT/$package_path"
  node -e '
const fs = require("node:fs");
const packageFile = process.argv[1];
const nextVersion = process.argv[2];
const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
packageJson.version = nextVersion;
fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
' "$package_file" "$next"
done

# `release_version_source_paths` is assigned by the sourced lib.sh.
# shellcheck disable=SC2154
for source_path in "${release_version_source_paths[@]}"; do
  source_file="$RELEASE_ROOT/$source_path"
  node -e '
const fs = require("node:fs");
const sourceFile = process.argv[1];
const nextVersion = process.argv[2];
const source = fs.readFileSync(sourceFile, "utf8");
const pattern = /^export const VERSION = "[^"\r\n]+";$/m;
if (!pattern.test(source)) throw new Error(`Missing VERSION constant in ${sourceFile}`);
fs.writeFileSync(sourceFile, source.replace(pattern, `export const VERSION = "${nextVersion}";`));
' "$source_file" "$next"
done

printf 'Bumped package and VERSION files to %s; regenerating the OpenAPI document.\n' "$next"
pnpm openapi:generate

printf 'OpenAPI document regenerated for %s; installing dependencies.\n' "$next"
pnpm install

if ! git diff --exit-code -- pnpm-lock.yaml; then
  release_error 'pnpm-lock.yaml changed during a version-only bump; release stopped.'
  exit 1
fi

printf 'Bump complete: %s\n' "$next"
