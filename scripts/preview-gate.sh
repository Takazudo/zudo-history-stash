#!/usr/bin/env bash

set -euo pipefail

write_ready() {
  local value="$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'ready=%s\n' "$value" >>"$GITHUB_OUTPUT"
  else
    printf 'ready=%s\n' "$value"
  fi
}

case "${PREVIEW_IS_FORK:-}" in
  true)
    write_ready false
    printf '%s\n' '::notice::PR previews are disabled for fork pull requests.'
    exit 0
    ;;
  false)
    ;;
  *)
    write_ready false
    printf '%s\n' '::error::PREVIEW_IS_FORK must be exactly true or false.' >&2
    exit 1
    ;;
esac

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  write_ready false
  printf '%s\n' '::notice::PR previews are disabled until both Cloudflare credentials are configured.'
  exit 0
fi

write_ready true
