#!/usr/bin/env bash
set -uo pipefail

# Pre-push check suite for zudo-history-stash. Keep this sequence aligned with
# CI: library dist must exist before workspace consumers typecheck or test.
# Failures are collected so one run reports every broken step. The command
# sequence is checked against the CI quality job before the build checks run.

START_TIME=$(date +%s)
FAILURES=()

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

step() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "▶ $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

run_step() {
  local label="$1"
  shift
  step "$label"
  if (cd "$ROOT_DIR" && "$@"); then
    echo "✅ $label"
  else
    echo "❌ $label"
    FAILURES+=("$label")
  fi
}

run_step "Step 1/9: Install dependencies (frozen lockfile)" pnpm install --frozen-lockfile
run_step "Step 2/9: B4push/CI parity"                       pnpm check:b4push-ci-parity
run_step "Step 3/9: Build libraries"                       pnpm build:libs
run_step "Step 4/9: Format check"                         pnpm format:check
run_step "Step 5/9: Typecheck"                            pnpm typecheck
run_step "Step 6/9: Lint"                                 pnpm lint
run_step "Step 7/9: Design-token lint"                    pnpm lint:tokens
run_step "Step 8/9: Tests"                                pnpm test
run_step "Step 9/9: Build"                                pnpm build

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SUMMARY (${DURATION}s)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ${#FAILURES[@]} -eq 0 ]; then
  echo "✅ All checks passed! Safe to push."
  exit 0
fi

echo "❌ ${#FAILURES[@]} check(s) failed:"
for failure in "${FAILURES[@]}"; do
  echo "   - $failure"
done
exit 1
