#!/usr/bin/env bash
set -euo pipefail

release_command_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$release_command_dir/lib.sh"

usage() {
  cat >&2 <<'USAGE'
Usage: bash scripts/release.sh tag [--dry-run]

RELEASE_TEST_MODE=1 additionally permits --branch BRANCH and --skip-ci-check.
USAGE
}

dry_run=0
branch_override=''
skip_ci_check=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --branch)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || release_usage_error '--branch requires a branch name'
      branch_override=$2
      shift 2
      ;;
    --skip-ci-check)
      skip_ci_check=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage
      release_usage_error "Unknown tag argument: $1"
      ;;
  esac
done

if [[ -n "$branch_override" && "${RELEASE_TEST_MODE:-}" != '1' ]]; then
  release_error '--branch is available only when RELEASE_TEST_MODE=1.'
  exit 2
fi
if ((skip_ci_check)) && [[ "${RELEASE_TEST_MODE:-}" != '1' ]]; then
  release_error '--skip-ci-check is available only when RELEASE_TEST_MODE=1.'
  exit 2
fi
if [[ (-n "$branch_override" || "$skip_ci_check" == '1') && "$dry_run" != '1' ]]; then
  release_error 'Test-only branch and CI overrides require --dry-run.'
  exit 2
fi

expected_branch=${branch_override:-main}

# Fetch first so every following local and remote-ref check uses current tag and
# branch information. Fetching refs does not alter the worktree.
git fetch --tags origin
require_clean_tree
require_branch "$expected_branch"

head_sha=$(git rev-parse HEAD)
if ! origin_sha=$(git rev-parse "refs/remotes/origin/$expected_branch" 2>/dev/null); then
  release_error "Could not resolve origin/$expected_branch; fetch the branch and retry."
  exit 1
fi
if [[ "$head_sha" != "$origin_sha" ]]; then
  release_error "HEAD ($head_sha) must exactly match origin/$expected_branch ($origin_sha)."
  exit 1
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
next=$core_package_version
if [[ ! "$next" =~ $plain_semver_re ]]; then
  release_error "NEXT=$next violates the plain SemVer rule $plain_semver_re."
  exit 1
fi
if [[ "$client_package_version" != "$next" ||
  "$core_version_constant" != "$next" ||
  "$client_version_constant" != "$next" ]]; then
  release_error "Bump commit is incomplete at HEAD: core package=$next, client package=$client_package_version, core VERSION=$core_version_constant, client VERSION=$client_version_constant."
  exit 1
fi

openapi_version=$(release_openapi_version)
if [[ "$openapi_version" != "$next" ]]; then
  release_error "Bump commit is incomplete at HEAD: docs/openapi.json info.version=$openapi_version, expected $next."
  exit 1
fi

tag_name="v$next"
if [[ -n "$(git tag -l "$tag_name")" ]]; then
  release_error "Tag $tag_name already exists locally."
  exit 1
fi
if [[ -n "$(git ls-remote --tags origin "$tag_name")" ]]; then
  release_error "Tag $tag_name already exists on origin."
  exit 1
fi

if ((!skip_ci_check)); then
  ci_max_attempts=30
  ci_poll_seconds=10
  if [[ "${RELEASE_TEST_MODE:-}" == '1' ]]; then
    ci_max_attempts=${RELEASE_TAG_CI_MAX_ATTEMPTS:-$ci_max_attempts}
    ci_poll_seconds=${RELEASE_TAG_CI_POLL_SECONDS:-$ci_poll_seconds}
  fi
  if [[ ! "$ci_max_attempts" =~ ^[1-9][0-9]*$ || ! "$ci_poll_seconds" =~ ^[0-9]+$ ]]; then
    release_error 'Test retry overrides must be non-negative integers with at least one attempt.'
    exit 2
  fi

  ci_ready=0
  for ((attempt = 1; attempt <= ci_max_attempts; attempt++)); do
    if ! runs_json=$(gh run list --workflow ci.yml --commit "$head_sha" \
      --json databaseId,status,conclusion 2>&1); then
      release_error "Unable to query CI runs for $head_sha: $runs_json"
      exit 1
    fi
    if ! selected_run=$(node -e '
const runs = JSON.parse(process.argv[1]);
if (!Array.isArray(runs)) throw new Error("gh run list did not return an array");
const valid = runs.filter((run) => Number.isSafeInteger(run.databaseId));
valid.sort((left, right) => right.databaseId - left.databaseId);
if (valid[0]) process.stdout.write(JSON.stringify(valid[0]));
' "$runs_json" 2>&1); then
      release_error "Unable to parse CI runs for $head_sha: $selected_run"
      exit 1
    fi

    if [[ -n "$selected_run" ]]; then
      IFS=$'\t' read -r run_id run_status run_conclusion < <(node -e '
const run = JSON.parse(process.argv[1]);
process.stdout.write(`${run.databaseId}\t${run.status ?? ""}\t${run.conclusion ?? ""}\n`);
' "$selected_run")
      if [[ "$run_status" == 'completed' ]]; then
        if [[ "$run_conclusion" != 'success' ]]; then
          release_error "Latest CI run $run_id for $head_sha concluded '$run_conclusion', not success."
          exit 1
        fi
        printf 'CI run %s succeeded for %s.\n' "$run_id" "$head_sha"
        ci_ready=1
        break
      fi
      printf 'CI run %s for %s is %s; waiting (%d/%d).\n' \
        "$run_id" "$head_sha" "${run_status:-unknown}" "$attempt" "$ci_max_attempts"
    else
      printf 'No CI run found yet for %s; waiting (%d/%d).\n' \
        "$head_sha" "$attempt" "$ci_max_attempts"
    fi
    if ((attempt < ci_max_attempts)); then
      sleep "$ci_poll_seconds"
    fi
  done
  if ((!ci_ready)); then
    release_error "No successful CI run became available for $head_sha after $ci_max_attempts attempts. Open the ci.yml runs for this commit, wait for success, and retry."
    exit 1
  fi
else
  printf 'Skipping CI check in RELEASE_TEST_MODE.\n'
fi

if ((dry_run)); then
  printf 'git tag %q %q\n' "$tag_name" "$head_sha"
  printf 'git push origin %q\n' "$tag_name"
  exit 0
fi

git tag "$tag_name" "$head_sha"
git push origin "$tag_name"
printf 'Created and pushed %s at %s.\n' "$tag_name" "$head_sha"
