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

if [[ "${PRODUCTION_DEPLOY_DISABLED:-}" == "true" ]]; then
  write_ready false
  printf '%s\n' '::notice::Production deploys are disabled by repository variable; deployment is skipped.'
  exit 0
fi

if [[ -z "${DEPLOY_TARGET:-}" || -z "${DEPLOY_WRANGLER_CONFIG:-}" ]]; then
  write_ready false
  printf '%s\n' '::error::DEPLOY_TARGET and DEPLOY_WRANGLER_CONFIG are required.' >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  write_ready false
  printf '::notice::Cloudflare secrets are not configured; %s deployment is skipped.\n' "$DEPLOY_TARGET"
  exit 0
fi

if [[ ! -f "$DEPLOY_WRANGLER_CONFIG" || ! -r "$DEPLOY_WRANGLER_CONFIG" ]]; then
  write_ready false
  printf '::notice::%s is missing; %s deployment is skipped.\n' "$DEPLOY_WRANGLER_CONFIG" "$DEPLOY_TARGET"
  exit 0
fi

if [[ -n "${DEPLOY_REQUIRED_KEY_PATTERN:-}" ]]; then
  if ! grep -Eq -- "$DEPLOY_REQUIRED_KEY_PATTERN" "$DEPLOY_WRANGLER_CONFIG"; then
    write_ready false
    printf '::notice::%s has no provisioned binding; %s deployment is skipped.\n' "$DEPLOY_WRANGLER_CONFIG" "$DEPLOY_TARGET"
    exit 0
  fi
fi

if grep -Eq -- 'REPLACE_(ME|WITH)|__[A-Z][A-Z0-9_]*__' "$DEPLOY_WRANGLER_CONFIG"; then
  write_ready false
  printf '::notice::%s still contains placeholder values; %s deployment is skipped.\n' "$DEPLOY_WRANGLER_CONFIG" "$DEPLOY_TARGET"
  exit 0
fi

if grep -Eq -- '^[[:space:]]*pattern[[:space:]]*=.*\.(example\.(com|net|org)|invalid|test|localhost)' "$DEPLOY_WRANGLER_CONFIG"; then
  write_ready false
  printf '::notice::%s routes an unownable placeholder hostname; %s deployment is skipped.\n' "$DEPLOY_WRANGLER_CONFIG" "$DEPLOY_TARGET"
  exit 0
fi

write_ready true
