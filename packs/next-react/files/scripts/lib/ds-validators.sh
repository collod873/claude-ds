#!/usr/bin/env bash
# ds-validators.sh — Shared validation functions for design-system governance.
# Sourced by both scripts/check-design-system.sh (CI) and hooks (per-save).
# Every function outputs to stderr in the contract format: <file>:<line>: <RULE-ID>: <hint>
# Functions return 0 = clean, 2 = violation found.
#
# Source with: source "$(dirname "$0")/lib/ds-validators.sh"  (or adjust path)

# ds_check_classification FILE
# CLASS-001: atom file imports a DS module → should be composite.
# Recognizes BOTH alias spellings (`@/design-system/...` and `@ds/...`) —
# tsconfig maps them to the same files, so pinning to one form silently
# blinds the rule on the other (ADR-0009 addendum / PRD #340 / #346).
# Returns 2 if violation, 0 if clean.
ds_check_classification() {
  local file="$1"
  local rc=0

  case "$file" in
    *design-system/atoms/*.tsx) ;;
    *) return 0 ;;  # Not an atom — skip
  esac

  # Skip companion suffixes
  case "$file" in
    *.showcase.tsx|*.test.tsx|*.stories.tsx) return 0 ;;
  esac

  # Match either `from '@/design-system/...'` or `from '@ds/...'` but exclude
  # type-only imports (`import type { ... } from '...'`). A type-only import
  # carries no runtime dependency, so it does not violate atom classification.
  # Lines starting with `import type` (optionally preceded by whitespace) are
  # filtered out before flagging.
  local ds_import_re='from\s+["'"'"'][^"'"'"']*(@/design-system|@ds)/'
  if grep -nE "$ds_import_re" "$file" 2>/dev/null \
       | grep -vE '^[0-9]+:\s*import\s+type\b' >/dev/null 2>&1; then
    while IFS=: read -r line _rest; do
      local hint="CLASS-001: atom imports a DS module (@/design-system/* or @ds/*) — move to composites/ or run: npx claude-ds reconform --backfill-meta --fix"
      echo "$file:$line: CLASS-001: $hint" >&2
      if [ -f ".claude/hooks/lib/log-failure.sh" ]; then
        bash .claude/hooks/lib/log-failure.sh "CLASS-001" "$file" "$line" "$hint" || true
      fi
    done < <(grep -nE "$ds_import_re" "$file" \
               | grep -vE '^[0-9]+:\s*import\s+type\b')
    rc=2
  fi

  return $rc
}

# ds_check_fixtures FILE
# FIX-001: meta.fixtures contains inline object literal (2+ keys) that duplicates
#          a shape already exported from design-system/_fixtures/*.ts.
# Returns 2 if violation, 0 if clean.
ds_check_fixtures() {
  local file="$1"
  local rc=0

  case "$file" in
    *design-system/atoms/*.tsx|*design-system/composites/*.tsx|*design-system/references/*.tsx) ;;
    *) return 0 ;;
  esac

  case "$file" in
    *.showcase.tsx|*.test.tsx|*.stories.tsx) return 0 ;;
  esac

  [ -f "$file" ] || return 0

  # Detect inline object literal in meta.fixtures with 2+ keys.
  # Heuristic: look for 'fixtures' followed by an object literal on the same or next line
  # that contains at least 2 key: value pairs (simplified detection).
  local fixtures_block
  fixtures_block=$(grep -A 10 'fixtures\s*:' "$file" 2>/dev/null | head -20 || true)

  if [ -z "$fixtures_block" ]; then
    return 0
  fi

  # Count keys in the fixtures block (look for "word:" patterns inside {})
  local key_count
  key_count=$(echo "$fixtures_block" | grep -oE '[a-zA-Z_][a-zA-Z0-9_]*\s*:' | wc -l | tr -d ' ')

  if [ "$key_count" -lt 2 ]; then
    return 0
  fi

  # Check if it's an inline literal (not an import/reference)
  if ! echo "$fixtures_block" | grep -qE '^\s*fixtures\s*:\s*\{'; then
    return 0
  fi

  # Extract key names from the inline fixtures object
  local inline_keys
  inline_keys=$(echo "$fixtures_block" | grep -oE '[a-zA-Z_][a-zA-Z0-9_]*\s*:' | sed 's/\s*://' | tr '\n' '|' | sed 's/|$//')

  if [ -z "$inline_keys" ]; then
    return 0
  fi

  # Determine _fixtures/ dir relative to the project root
  local fixtures_dir
  local project_root
  project_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  fixtures_dir="$project_root/design-system/_fixtures"

  [ -d "$fixtures_dir" ] || return 0

  # Search for any _fixtures/*.ts file that exports an object with overlapping keys
  local fixture_file
  for fixture_file in "$fixtures_dir"/*.ts; do
    [ -f "$fixture_file" ] || continue

    # Check for exported object with overlapping keys
    local fixture_keys
    fixture_keys=$(grep -oE 'export\s+(const|let)\s+[a-zA-Z_][a-zA-Z0-9_]*' "$fixture_file" 2>/dev/null || true)
    if [ -z "$fixture_keys" ]; then
      continue
    fi

    # Check if any of the inline fixture keys appear in the fixture file
    local old_ifs="$IFS"
    IFS='|'
    for key in $inline_keys; do
      if grep -qE "^\s*${key}\s*:" "$fixture_file" 2>/dev/null; then
        IFS="$old_ifs"
        local fixture_basename
        fixture_basename="$(basename "$fixture_file")"
        local line
        line=$(grep -n 'fixtures\s*:' "$file" 2>/dev/null | head -1 | cut -d: -f1 || echo "0")
        local hint="FIX-001: meta.fixtures contains inline literal matching shape in _fixtures/${fixture_basename} — import from design-system/_fixtures/${fixture_basename%.ts} instead"
        echo "$file:${line}: FIX-001: $hint" >&2
        if [ -f ".claude/hooks/lib/log-failure.sh" ]; then
          bash .claude/hooks/lib/log-failure.sh "FIX-001" "$file" "${line}" "$hint" || true
        fi
        rc=2
        break 2
      fi
    done
    IFS="$old_ifs"
  done

  return $rc
}
