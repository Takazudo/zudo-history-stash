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
    -* )
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

core_package_version=$(release_package_version "$RELEASE_ROOT/packages/core/package.json")
client_package_version=$(release_package_version "$RELEASE_ROOT/packages/client/package.json")
if ! core_version_constant=$(release_version_constant "$RELEASE_ROOT/packages/core/src/index.ts"); then
  release_error 'Could not read exactly one VERSION constant from packages/core/src/index.ts.'
  exit 1
fi
if ! client_version_constant=$(release_version_constant "$RELEASE_ROOT/packages/client/src/index.ts"); then
  release_error 'Could not read exactly one VERSION constant from packages/client/src/index.ts.'
  exit 1
fi

if [[ "$core_package_version" != "$client_package_version" ||
  "$core_package_version" != "$core_version_constant" ||
  "$core_package_version" != "$client_version_constant" ]]; then
  release_error "Version mismatch: packages/core/package.json=$core_package_version, packages/client/package.json=$client_package_version, packages/core/src/index.ts=$core_version_constant, packages/client/src/index.ts=$client_version_constant."
  exit 1
fi

current=$core_package_version
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

if [[ ! "$next" =~ $plain_semver_re ]]; then
  release_error "NEXT=$next violates the plain SemVer rule $plain_semver_re; prerelease and build metadata are not allowed."
  exit 1
fi

if ! release_semver_greater "$next" "$current"; then
  release_error "NEXT=$next must be strictly greater than current version $current."
  exit 1
fi

core_changelog="$RELEASE_ROOT/packages/core/CHANGELOG.md"
client_changelog="$RELEASE_ROOT/packages/client/CHANGELOG.md"
for changelog in "$core_changelog" "$client_changelog"; do
  heading_count=$(release_changelog_heading_count "$changelog" "$next")
  if [[ "$heading_count" != '1' ]]; then
    relative_changelog=${changelog#"$RELEASE_ROOT/"}
    release_error "$relative_changelog must contain exactly one '## $next — YYYY-MM-DD' heading (found $heading_count)."
    exit 1
  fi
done

version_files=(
  'packages/core/package.json'
  'packages/client/package.json'
  'packages/core/src/index.ts'
  'packages/client/src/index.ts'
)

if ((dry_run)); then
  printf 'NEXT=%s\n' "$next"
  printf '%s\n' "${version_files[@]}"
  exit 0
fi

require_clean_tree

for package_file in "$RELEASE_ROOT/packages/core/package.json" "$RELEASE_ROOT/packages/client/package.json"; do
  node -e '
const fs = require("node:fs");
const packageFile = process.argv[1];
const nextVersion = process.argv[2];
const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
packageJson.version = nextVersion;
fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
' "$package_file" "$next"
done

for source_file in "$RELEASE_ROOT/packages/core/src/index.ts" "$RELEASE_ROOT/packages/client/src/index.ts"; do
  node -e '
const fs = require("node:fs");
const sourceFile = process.argv[1];
const nextVersion = process.argv[2];
const source = fs.readFileSync(sourceFile, "utf8");
const pattern = /^export const VERSION = "[^"\\r\\n]+";$/m;
if (!pattern.test(source)) throw new Error(`Missing VERSION constant in ${sourceFile}`);
fs.writeFileSync(sourceFile, source.replace(pattern, `export const VERSION = "${nextVersion}";`));
' "$source_file" "$next"
done

printf 'Bumped package and VERSION files to %s; installing dependencies.\n' "$next"
pnpm install

if ! git diff --exit-code -- pnpm-lock.yaml; then
  release_error 'pnpm-lock.yaml changed during a version-only bump; release stopped.'
  exit 1
fi

printf 'Bump complete: %s\n' "$next"
