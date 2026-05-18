#!/usr/bin/env bash
# Tier A scope-gate: fires on any .tsx write outside design-system/
# AESTH-001: no inline style={...} attributes — force token usage
# AESTH-002: no raw hex colors (#rrggbb / #rgb) in app .tsx
# AESTH-003: no raw spacing literals (px/rem integers) in padding/margin/gap or Tailwind arbitrary values
set -euo pipefail

file="$1"

# Skip non-.tsx files
case "$file" in
  *.tsx) ;;
  *) exit 0 ;;
esac

# Skip files under design-system/ — those belong to Tier B
case "$file" in
  *design-system/*) exit 0 ;;
esac

if [ ! -f "$file" ]; then
  exit 0
fi

rc=0

# AESTH-001: inline style={...} prop on a JSX element
if grep -nE 'style=\{' "$file" >/dev/null 2>&1; then
  while IFS=: read -r line _rest; do
    hint="AESTH-001: inline style prop found; use a design-system token or className instead"
    echo "$file:$line: AESTH-001: $hint" >&2
    bash .claude/hooks/lib/log-failure.sh "AESTH-001" "$file" "$line" "$hint" || true
  done < <(grep -nE 'style=\{' "$file")
  rc=2
fi

# AESTH-002: raw hex color literals (#rgb or #rrggbb or #rrggbbaa)
if grep -nE '"#[0-9a-fA-F]{3,8}"|'"'"'#[0-9a-fA-F]{3,8}'"'" "$file" >/dev/null 2>&1; then
  while IFS=: read -r line _rest; do
    hint="AESTH-002: raw hex color found; reference a token from design-system/tokens.json instead"
    echo "$file:$line: AESTH-002: $hint" >&2
    bash .claude/hooks/lib/log-failure.sh "AESTH-002" "$file" "$line" "$hint" || true
  done < <(grep -nE '"#[0-9a-fA-F]{3,8}"|'"'"'#[0-9a-fA-F]{3,8}'"'" "$file")
  rc=2
fi

# AESTH-003: raw spacing literals — Tailwind arbitrary [Npx]/[Nrem], or padding/margin/gap: Npx/Nrem
if grep -nE '\b(padding|margin|gap):[[:space:]]*[0-9]+(px|rem)\b|\b[pmg][trblxy]?-\[[0-9]+(px|rem)\]' "$file" >/dev/null 2>&1; then
  while IFS=: read -r line _rest; do
    hint="AESTH-003: raw spacing literal found; use a space-* token from design-system/tokens.json"
    echo "$file:$line: AESTH-003: $hint" >&2
    bash .claude/hooks/lib/log-failure.sh "AESTH-003" "$file" "$line" "$hint" || true
  done < <(grep -nE '\b(padding|margin|gap):[[:space:]]*[0-9]+(px|rem)\b|\b[pmg][trblxy]?-\[[0-9]+(px|rem)\]' "$file")
  rc=2
fi

exit $rc
