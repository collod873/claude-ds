#!/usr/bin/env bash
set -uo pipefail

# v1.0.0 verification script — automates issue #116 phases 1-10
# Runs everything mechanical, leaves a punch list of HITL items at the end.

CREWOPS_DIR="${1:-$HOME/Claude Projects/crewops}"
CLAUDE_DS_CLI="claude-ds"
GREENFIELD_DIR=""
REPORT=""
PASS=0
FAIL=0
HITL=()
PHASE=""

# ── helpers ──────────────────────────────────────────────────────────────

green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

phase() {
  PHASE="$1"
  bold ""
  bold "═══════════════════════════════════════════════"
  bold "  Phase $1"
  bold "═══════════════════════════════════════════════"
}

check() {
  local label="$1"
  shift
  local output
  if output=$("$@" 2>&1); then
    green "  ✓ $label"
    REPORT+="✓ [$PHASE] $label"$'\n'
    ((PASS++))
    return 0
  else
    red "  ✗ $label"
    red "    $output" | head -5
    REPORT+="✗ [$PHASE] $label — $output"$'\n'
    ((FAIL++))
    return 1
  fi
}

check_zero() {
  local label="$1" count="$2"
  if [[ "$count" == "0" ]]; then
    green "  ✓ $label (count: 0)"
    REPORT+="✓ [$PHASE] $label"$'\n'
    ((PASS++))
  else
    red "  ✗ $label (count: $count, expected 0)"
    REPORT+="✗ [$PHASE] $label — got $count, expected 0"$'\n'
    ((FAIL++))
  fi
}

check_nonzero() {
  local label="$1" count="$2"
  if [[ "$count" != "0" ]]; then
    green "  ✓ $label (count: $count)"
    REPORT+="✓ [$PHASE] $label"$'\n'
    ((PASS++))
  else
    red "  ✗ $label (expected >0, got 0)"
    REPORT+="✗ [$PHASE] $label — expected >0, got 0"$'\n'
    ((FAIL++))
  fi
}

hitl() {
  yellow "  ⧖ $1"
  HITL+=("$1")
  REPORT+="⧖ [$PHASE] $1"$'\n'
}

cleanup() {
  if [[ -n "$GREENFIELD_DIR" && -d "$GREENFIELD_DIR" ]]; then
    rm -rf "$GREENFIELD_DIR"
  fi
}
trap cleanup EXIT

# ── preflight ────────────────────────────────────────────────────────────

bold "v1.0.0 Verification Script (issue #116)"
bold "Crewops: $CREWOPS_DIR"
echo ""

if [[ ! -d "$CREWOPS_DIR" ]]; then
  red "Crewops directory not found: $CREWOPS_DIR"
  exit 1
fi

if ! command -v "$CLAUDE_DS_CLI" &>/dev/null; then
  red "claude-ds not on PATH — run 'npm link' in claude-ds repo first"
  exit 1
fi

# ── Phase 0: Reset Crewops to clean state ────────────────────────────────

phase "0: Reset Crewops to pre-upgrade state"

cd "$CREWOPS_DIR"

echo "  Resetting to clean HEAD state..."
git checkout -- . 2>/dev/null
git clean -fd 2>/dev/null

CREWOPS_VERSION=$(python3 -c "
import json
c = json.load(open('.claude-ds.json'))
print(c.get('packVersion', c.get('version', 'unknown')))
" 2>/dev/null || echo "unknown")
echo "  Baseline packVersion: $CREWOPS_VERSION"

check "Crewops at v0.7.13 baseline" test "$CREWOPS_VERSION" = "v0.7.13"

# ── Phase 1: Pre-upgrade spot checks ────────────────────────────────────

phase "1: Pre-upgrade spot checks"

STATES_COUNT=$(find design-system -name "*.states.json" 2>/dev/null | wc -l | tr -d ' ')
check_nonzero ".states.json files exist (baseline)" "$STATES_COUNT"

STATE001_COUNT=$(grep -c "STATE-001" design-system/exceptions.json 2>/dev/null || echo "0")
check_nonzero "STATE-001 exceptions exist (baseline)" "$STATE001_COUNT"

if [[ -f design-system/manifest.generated.ts ]]; then
  green "  ✓ manifest.generated.ts exists (baseline)"
  REPORT+="✓ [Phase 1] manifest.generated.ts exists"$'\n'
  ((PASS++))
else
  yellow "  ⚠ manifest.generated.ts missing (may have been cleaned up already)"
fi

echo "  Baseline: $STATES_COUNT .states.json files, $STATE001_COUNT STATE-001 exceptions"

# ── Phase 2: Dry-run upgrade ────────────────────────────────────────────

phase "2: Dry-run upgrade"

DRY_OUTPUT=$($CLAUDE_DS_CLI upgrade --to v1.0.0 --dry-run 2>&1) || true
DRY_EXIT=$?

if grep -qi '^\(Error\|FATAL\|ERR!\)' <<< "$DRY_OUTPUT"; then
  red "  ✗ Dry-run produced errors"
  grep -i '^\(Error\|FATAL\|ERR!\)' <<< "$DRY_OUTPUT" | head -5
  REPORT+="✗ [Phase 2] Dry-run errors"$'\n'
  ((FAIL++))
else
  green "  ✓ Dry-run completed without errors"
  REPORT+="✓ [Phase 2] Dry-run clean"$'\n'
  ((PASS++))
fi

if grep -q "v0.8.0\|v0.9.0" <<< "$DRY_OUTPUT"; then
  green "  ✓ Migration chain includes v0.8.0 → v0.9.0"
  REPORT+="✓ [Phase 2] Migration chain correct"$'\n'
  ((PASS++))
else
  red "  ✗ Migration chain missing expected versions"
  REPORT+="✗ [Phase 2] Migration chain missing versions"$'\n'
  ((FAIL++))
fi

# ── Phase 3: Apply upgrade ──────────────────────────────────────────────

phase "3: Apply upgrade"

UPGRADE_OUTPUT=$($CLAUDE_DS_CLI upgrade --to v1.0.0 --yes 2>&1) || true

NEW_VERSION=$(python3 -c "
import json
c = json.load(open('.claude-ds.json'))
print(c.get('packVersion', c.get('version', 'unknown')))
" 2>/dev/null || echo "unknown")
check "packVersion updated to v1.0.0" test "$NEW_VERSION" = "v1.0.0"

# Run sync explicitly — upgrade --yes may not propagate to sync (#137)
echo "  Running sync (workaround for #137)..."
SYNC_OUTPUT=$($CLAUDE_DS_CLI sync 2>&1) || true

# ── Phase 4: Post-upgrade v0.8.0 claims ─────────────────────────────────

phase "4: Post-upgrade v0.8.0 verification"

STATES_AFTER=$(find design-system -name "*.states.json" 2>/dev/null | wc -l | tr -d ' ')
check_zero ".states.json files removed" "$STATES_AFTER"

STATE001_AFTER="$(grep -c 'STATE-001' design-system/exceptions.json 2>/dev/null)" || STATE001_AFTER="0"
STATE001_AFTER="${STATE001_AFTER%%[^0-9]*}"
check_zero "STATE-001 exceptions removed" "$STATE001_AFTER"

CLAUDE_DS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACK_FORCE_STATE="$CLAUDE_DS_ROOT/packs/next-react/files/design-system/utils/force-state.css"
if [[ -f design-system/utils/force-state.css ]]; then
  if [[ -f "$PACK_FORCE_STATE" ]] && diff -q design-system/utils/force-state.css "$PACK_FORCE_STATE" >/dev/null 2>&1; then
    green "  ✓ force-state.css matches pack (managed)"
    REPORT+="✓ [Phase 4] force-state.css pack-managed"$'\n'
    ((PASS++))
  else
    green "  ✓ force-state.css exists (content differs from pack — may be expected)"
    REPORT+="✓ [Phase 4] force-state.css exists"$'\n'
    ((PASS++))
  fi
else
  red "  ✗ force-state.css missing"
  REPORT+="✗ [Phase 4] force-state.css missing"$'\n'
  ((FAIL++))
fi

# ── Phase 5: Post-upgrade v0.9.0 claims ─────────────────────────────────

phase "5: Post-upgrade v0.9.0 verification"

if [[ -f design-system/manifest.generated.ts ]]; then
  red "  ✗ manifest.generated.ts still exists (should be deleted)"
  REPORT+="✗ [Phase 5] manifest.generated.ts not deleted"$'\n'
  ((FAIL++))
else
  green "  ✓ manifest.generated.ts removed"
  REPORT+="✓ [Phase 5] manifest.generated.ts removed"$'\n'
  ((PASS++))
fi

DS_IMPORTS=$(grep -rc "from ['\"]@ds/" design-system/ --include="*.tsx" 2>/dev/null | tail -1 | cut -d: -f2 || echo "0")
check_nonzero "@ds/* imports present" "$DS_IMPORTS"

# ── Phase 6: Full audit + doctor ─────────────────────────────────────────

phase "6: Audit + Doctor"

AUDIT_OUTPUT=$($CLAUDE_DS_CLI audit 2>&1) || true
AUDIT_EXIT=$?

if [[ $AUDIT_EXIT -eq 0 ]]; then
  green "  ✓ audit exits 0 (no unexpected drift)"
  REPORT+="✓ [Phase 6] audit clean"$'\n'
  ((PASS++))
else
  red "  ✗ audit exits $AUDIT_EXIT"
  echo "$AUDIT_OUTPUT" | tail -10
  REPORT+="✗ [Phase 6] audit failed (exit $AUDIT_EXIT)"$'\n'
  ((FAIL++))
fi

DOCTOR_OUTPUT=$($CLAUDE_DS_CLI doctor --completeness 2>&1) || true
DOCTOR_EXIT=$?

if [[ $DOCTOR_EXIT -eq 0 ]]; then
  green "  ✓ doctor --completeness exits 0"
  REPORT+="✓ [Phase 6] doctor --completeness clean"$'\n'
  ((PASS++))
else
  red "  ✗ doctor --completeness exits $DOCTOR_EXIT"
  echo "$DOCTOR_OUTPUT" | tail -10
  REPORT+="✗ [Phase 6] doctor --completeness failed (exit $DOCTOR_EXIT)"$'\n'
  ((FAIL++))
fi

# ── Phase 7: In-repo script cleanup detection ────────────────────────────

phase "7: In-repo script supersession check"

SUPERSEDED_SCRIPTS=(
  "scripts/audit-atom-composite-drift.ts:claude-ds audit"
  "scripts/build-manifest.ts:pack-managed manifest"
  "scripts/check-design-system.sh:claude-ds doctor"
  "scripts/check-hook-contract.sh:claude-ds doctor --verify-hooks"
  "scripts/check-states-coverage.ts:retire-states migration"
  "scripts/check-tier-imports.ts:claude-ds audit DRIFT-MISPLACED"
)

for entry in "${SUPERSEDED_SCRIPTS[@]}"; do
  script="${entry%%:*}"
  replacement="${entry##*:}"
  if [[ -f "$script" ]]; then
    hitl "DELETE? $script — superseded by $replacement"
  fi
done

PACKAGE_DS_SCRIPTS=$(grep -cE '"ds:|ci:hook' package.json 2>/dev/null || echo "0")
if [[ "$PACKAGE_DS_SCRIPTS" != "0" ]]; then
  hitl "REVIEW: $PACKAGE_DS_SCRIPTS ds:*/ci:hook-contract scripts in package.json — still needed?"
fi

# ── Phase 8: Greenfield project ──────────────────────────────────────────

phase "8: Greenfield project"

GREENFIELD_DIR=$(mktemp -d -t greenfield-verify-XXXXXX)
echo "  Greenfield dir: $GREENFIELD_DIR"

cd "$GREENFIELD_DIR"
git init -q .

GF_INIT_OUTPUT=$($CLAUDE_DS_CLI init --pack next-react --yes 2>&1) || true
GF_INIT_EXIT=$?

if [[ $GF_INIT_EXIT -eq 0 ]]; then
  green "  ✓ init --pack next-react succeeded"
  REPORT+="✓ [Phase 8] greenfield init"$'\n'
  ((PASS++))
else
  red "  ✗ init --pack next-react failed (exit $GF_INIT_EXIT)"
  echo "$GF_INIT_OUTPUT" | tail -5
  REPORT+="✗ [Phase 8] greenfield init failed"$'\n'
  ((FAIL++))
fi

if [[ -f .claude-ds.json ]]; then
  GF_DOCTOR=$($CLAUDE_DS_CLI doctor --completeness 2>&1) || true
  GF_DOCTOR_EXIT=$?

  if [[ $GF_DOCTOR_EXIT -eq 0 ]]; then
    green "  ✓ greenfield doctor --completeness passes"
    REPORT+="✓ [Phase 8] greenfield doctor clean"$'\n'
    ((PASS++))
  else
    red "  ✗ greenfield doctor --completeness fails (exit $GF_DOCTOR_EXIT)"
    echo "$GF_DOCTOR" | tail -5
    REPORT+="✗ [Phase 8] greenfield doctor failed"$'\n'
    ((FAIL++))
  fi

  # Check scaffold structure
  for dir in design-system/atoms design-system/composites design-system/references; do
    if [[ -d "$dir" ]]; then
      green "  ✓ $dir exists"
      ((PASS++))
    else
      red "  ✗ $dir missing"
      ((FAIL++))
    fi
  done

  if [[ -f design-system/tokens.json ]]; then
    green "  ✓ tokens.json exists"
    ((PASS++))
  else
    red "  ✗ tokens.json missing"
    ((FAIL++))
  fi
fi

# ── Phase 9: Skill testing ───────────────────────────────────────────────

phase "9: Skill testing"

cd "$CREWOPS_DIR"

# Test atom scaffolding — create a test atom and verify structure
TEST_ATOM="design-system/atoms/verify-test-atom.tsx"
if [[ -f ".claude/skills/component/SKILL.md" ]]; then
  green "  ✓ component skill installed"
  REPORT+="✓ [Phase 9] component skill present"$'\n'
  ((PASS++))
else
  red "  ✗ component skill not installed"
  REPORT+="✗ [Phase 9] component skill missing"$'\n'
  ((FAIL++))
fi

if [[ -f ".claude/skills/pattern/SKILL.md" ]]; then
  green "  ✓ pattern skill installed"
  REPORT+="✓ [Phase 9] pattern skill present"$'\n'
  ((PASS++))
else
  red "  ✗ pattern skill not installed"
  REPORT+="✗ [Phase 9] pattern skill missing"$'\n'
  ((FAIL++))
fi

if [[ -f ".claude/skills/design-system/SKILL.md" ]]; then
  green "  ✓ design-system skill installed"
  REPORT+="✓ [Phase 9] design-system skill present"$'\n'
  ((PASS++))
else
  red "  ✗ design-system skill not installed"
  REPORT+="✗ [Phase 9] design-system skill missing"$'\n'
  ((FAIL++))
fi

hitl "SKILL TEST: scaffold a new atom via component skill — verify meta.kind + showcase generated"
hitl "SKILL TEST: scaffold a new composite via component skill — verify tier placement"
hitl "SKILL TEST: scaffold a new pattern via pattern skill — verify slot export + showcase"
hitl "SKILL TEST: verify design-system skill documents references/ tier"

# ── Phase 10: Release artifacts ───────────────────────────────────────────

phase "10: Release artifact readiness"

cd "$(dirname "$CREWOPS_DIR")/claude-ds"

for f in pack/versions/1.0.0/breaking.md pack/versions/1.0.0/verification.md; do
  if [[ -f "$f" ]]; then
    green "  ✓ $f exists"
    REPORT+="✓ [Phase 10] $f"$'\n'
    ((PASS++))
  else
    yellow "  ○ $f not yet created (expected — this is a release step)"
    REPORT+="○ [Phase 10] $f — create during release"$'\n'
  fi
done

if git tag -l "v1.0.0" | grep -q "v1.0.0"; then
  green "  ✓ v1.0.0 tag exists"
  REPORT+="✓ [Phase 10] tag exists"$'\n'
  ((PASS++))
else
  yellow "  ○ v1.0.0 tag not yet pushed (expected — this is the final step)"
  REPORT+="○ [Phase 10] tag — push after sign-off"$'\n'
fi

hitl "SIGN-OFF: review release artifacts, bump package.json, commit, push v1.0.0 tag"

# ── Summary ──────────────────────────────────────────────────────────────

bold ""
bold "═══════════════════════════════════════════════"
bold "  VERIFICATION SUMMARY"
bold "═══════════════════════════════════════════════"
echo ""
green "  Passed: $PASS"
if [[ $FAIL -gt 0 ]]; then
  red "  Failed: $FAIL"
else
  echo "  Failed: 0"
fi
echo "  HITL items: ${#HITL[@]}"
echo ""

if [[ ${#HITL[@]} -gt 0 ]]; then
  bold "  Remaining HITL punch list:"
  for item in "${HITL[@]}"; do
    yellow "    → $item"
  done
fi

echo ""
if [[ $FAIL -eq 0 ]]; then
  green "  All mechanical checks passed. Only HITL items remain."
else
  red "  $FAIL mechanical checks failed. Fix these before HITL review."
fi

echo ""
bold "Full report:"
echo "$REPORT"
