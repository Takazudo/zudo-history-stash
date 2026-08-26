#!/usr/bin/env bash
set -euo pipefail

release_command_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$release_command_dir/lib.sh"

usage() {
  cat >&2 <<'USAGE'
Usage: bash scripts/release.sh check [--branch BRANCH]

The branch override is available only with RELEASE_TEST_MODE=1 while validating
release tooling on a non-main branch.
USAGE
}

branch_override=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || release_usage_error "--branch requires a branch name"
      branch_override=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage
      release_usage_error "Unknown check argument: $1"
      ;;
  esac
done

if [[ -n "$branch_override" && "${RELEASE_TEST_MODE:-}" != '1' ]]; then
  release_error "--branch is available only when RELEASE_TEST_MODE=1."
  exit 2
fi

require_branch "${branch_override:-main}"
require_clean_tree

gh auth status
git fetch --tags origin

version=$(current_version)
printf 'Current version: %s\n' "$version"

mapfile -t release_tags < <(git tag --list 'v*' --sort=-version:refname)
conventional_commit_re='^([[:alnum:]-]+)(\([^)]*\))?(!)?:[[:space:]]'
breaking_commit_re='^([[:alnum:]-]+)(\([^)]*\))?!:[[:space:]]'

commit_prefix() {
  local subject=$1
  if [[ "$subject" =~ $conventional_commit_re ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    printf 'other\n'
  fi
}

print_grouped_commits() {
  local range_mode=$1
  local range_value=${2:-}
  local commit
  local subject
  local body
  local prefix
  local marker
  local -a commits=()
  local -a groups=()
  declare -A group_lines=()
  declare -A group_seen=()

  if [[ "$range_mode" == 'root' ]]; then
    mapfile -t commits < <(git rev-list --reverse HEAD)
  else
    mapfile -t commits < <(git rev-list --reverse "$range_value..HEAD")
  fi

  if [[ ${#commits[@]} -eq 0 ]]; then
    printf '(no commits)\n'
    return 0
  fi

  for commit in "${commits[@]}"; do
    subject=$(git show -s --format=%s "$commit")
    body=$(git show -s --format=%b "$commit")
    prefix=$(commit_prefix "$subject")
    marker=''
    if [[ "$subject" =~ $breaking_commit_re ]] || grep -Fq 'BREAKING CHANGE' <<<"$body"; then
      marker=' [BREAKING]'
    fi
    if [[ -z "${group_seen[$prefix]+seen}" ]]; then
      groups+=("$prefix")
      group_seen[$prefix]=1
      group_lines[$prefix]=''
    fi
    if [[ -n "${group_lines[$prefix]}" ]]; then
      group_lines[$prefix]+=$'\n'
    fi
    group_lines[$prefix]+="${commit:0:10} ${subject}${marker}"
  done

  printf 'Grouped commits:\n'
  for prefix in "${groups[@]}"; do
    printf '\n[%s]\n%s\n' "$prefix" "${group_lines[$prefix]}"
  done
}

if [[ ${#release_tags[@]} -eq 0 ]]; then
  printf 'No v* tags found; first release.\n'
  print_grouped_commits root
else
  last_tag=${release_tags[0]}
  printf 'Last release tag: %s\n' "$last_tag"
  print_grouped_commits tagged "$last_tag"
fi

current_tag="v${version}"
if ! git rev-parse --verify --quiet "refs/tags/$current_tag" >/dev/null; then
  resume_sha=''
  while IFS=$'\t' read -r commit subject; do
    if [[ "$subject" == "chore(release): bump to $current_tag" ]]; then
      resume_sha=$commit
      break
    fi
  done < <(git log --format='%H%x09%s' HEAD)
  if [[ -n "$resume_sha" ]]; then
    printf 'Resume candidate: %s (chore(release): bump to %s); resume at `tag`.\n' \
      "$resume_sha" "$current_tag"
  fi
fi
