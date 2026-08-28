#!/usr/bin/env bash
set -uo pipefail

START_TIME=$(date +%s)
FAILURES=()

DOC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(cd "$DOC_DIR/.." && pwd)"

step() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "▶ $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

run_step() {
  local label="$1"
  local directory="$2"
  shift 2
  step "$label"
  if (cd "$directory" && "$@"); then
    echo "✅ $label"
    return 0
  fi
  echo "❌ $label"
  FAILURES+=("$label")
  return 1
}

skip_dependent_step() {
  local label="$1"
  step "$label"
  echo "❌ SKIP: authoritative Docs build failed; stale dist is not valid input."
  FAILURES+=("$label (build prerequisite failed)")
}

run_build_step() {
  local label="$1"
  step "$label"
  if ! rm -rf -- "$DOC_DIR/dist"; then
    echo "❌ $label"
    echo "   Could not remove the previous doc/dist; refusing to build or validate stale output."
    FAILURES+=("$label (stale dist cleanup failed)")
    return 1
  fi
  if (cd "$DOC_DIR" && pnpm build) && [[ -d "$DOC_DIR/dist" ]]; then
    echo "✅ $label"
    return 0
  fi
  echo "❌ $label"
  if [[ ! -d "$DOC_DIR/dist" ]]; then
    echo "   The authoritative build did not create doc/dist."
  fi
  FAILURES+=("$label")
  return 1
}

run_step "Step 1/13: Build libraries" "$ROOT_DIR" pnpm build:libs
run_step "Step 2/13: Markdown format check" "$DOC_DIR" pnpm format:md:check
run_step "Step 3/13: Template drift" "$DOC_DIR" pnpm check:template-drift
run_step "Step 4/13: Pin parity" "$DOC_DIR" pnpm check:pin-parity
run_step "Step 5/13: Wrangler pin" "$DOC_DIR" pnpm check:wrangler-pin
run_step "Step 6/13: Contract parity" "$DOC_DIR" pnpm check:contract
run_step "Step 7/13: Version wiring" "$DOC_DIR" pnpm check:versions
run_step "Step 8/13: Checked examples" "$DOC_DIR" pnpm check:examples
run_step "Step 9/13: Locale parity" "$DOC_DIR" pnpm check:locale-parity
run_step "Step 10/13: zfb check" "$DOC_DIR" pnpm check

BUILD_SUCCEEDED=false
if run_build_step "Step 11/13: Fresh Docs build"; then
  BUILD_SUCCEEDED=true
fi

if [[ "$BUILD_SUCCEEDED" == "true" ]]; then
  run_step "Step 12/13: HTML validation" "$DOC_DIR" pnpm check:html
  run_step "Step 13/13: Link validation" "$DOC_DIR" pnpm check:links
else
  skip_dependent_step "Step 12/13: HTML validation"
  skip_dependent_step "Step 13/13: Link validation"
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DOC SUMMARY (${DURATION}s)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ ${#FAILURES[@]} -eq 0 ]]; then
  echo "✅ All 13 Docs checks passed."
  exit 0
fi

echo "❌ ${#FAILURES[@]} Docs check(s) failed:"
for failure in "${FAILURES[@]}"; do
  echo "   - $failure"
done
exit 1
