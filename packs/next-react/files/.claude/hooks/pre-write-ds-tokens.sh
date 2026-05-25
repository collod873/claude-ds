#!/usr/bin/env bash
# Tier B position 2 — TOK-* family: forbids raw value literals in design-system/**
# Fires on any file under design-system/ EXCEPT design-system/tokens.json itself.
# TOK-001: no raw hex / rgb() / rgba() / hsl() color values
# TOK-002: no raw spacing magic numbers (px/rem) in CSS props or Tailwind arbitrary values
# TOK-003: no raw font-size / font-weight magic numbers
set -euo pipefail

source "$(dirname "$0")/lib/read-hook-input.sh"
file="$HOOK_FILE_PATH"
if [ -z "$file" ]; then exit 0; fi

# Only fire for files under design-system/
case "$file" in
  *design-system/*) ;;
  *) exit 0 ;;
esac

# Skip tokens.json itself — that IS the token source of truth
case "$file" in
  *design-system/tokens.json) exit 0 ;;
esac

if [ ! -f "$file" ]; then
  exit 0
fi

rc=0

# TOK-001: raw color literals — hex, rgb(), rgba(), hsl()
if grep -nE '"#[0-9a-fA-F]{3,8}"|'"'"'#[0-9a-fA-F]{3,8}'"'"'|[^a-zA-Z](rgb|rgba|hsl)\([^)]+\)' "$file" >/dev/null 2>&1; then
  while IFS=: read -r line _rest; do
    hint="TOK-001: raw color value found; reference a color token from design-system/tokens.json"
    echo "$file:$line: TOK-001: $hint" >&2
    bash .claude/hooks/lib/log-failure.sh "TOK-001" "$file" "$line" "$hint" || true
  done < <(grep -nE '"#[0-9a-fA-F]{3,8}"|'"'"'#[0-9a-fA-F]{3,8}'"'"'|[^a-zA-Z](rgb|rgba|hsl)\([^)]+\)' "$file")
  rc=2
fi

# TOK-002: raw spacing magic numbers — px/rem in CSS props or Tailwind arbitrary values
if grep -nE '\b(padding|margin|gap):[[:space:]]*[0-9]+(px|rem)\b|\b[pmg][trblxy]?-\[[0-9]+(px|rem)\]' "$file" >/dev/null 2>&1; then
  while IFS=: read -r line _rest; do
    hint="TOK-002: raw spacing literal found; use a space-* token from design-system/tokens.json"
    echo "$file:$line: TOK-002: $hint" >&2
    bash .claude/hooks/lib/log-failure.sh "TOK-002" "$file" "$line" "$hint" || true
  done < <(grep -nE '\b(padding|margin|gap):[[:space:]]*[0-9]+(px|rem)\b|\b[pmg][trblxy]?-\[[0-9]+(px|rem)\]' "$file")
  rc=2
fi

# TOK-003: raw font-size / font-weight magic numbers
if grep -nE '\bfont-?(size|weight):[[:space:]]*[0-9]+(px|rem|pt)?\b|\btext-\[[0-9]+(px|rem)\]|\bfont-\[[0-9]+\]' "$file" >/dev/null 2>&1; then
  while IFS=: read -r line _rest; do
    hint="TOK-003: raw font-size or font-weight found; use a type-scale token from design-system/tokens.json"
    echo "$file:$line: TOK-003: $hint" >&2
    bash .claude/hooks/lib/log-failure.sh "TOK-003" "$file" "$line" "$hint" || true
  done < <(grep -nE '\bfont-?(size|weight):[[:space:]]*[0-9]+(px|rem|pt)?\b|\btext-\[[0-9]+(px|rem)\]|\bfont-\[[0-9]+\]' "$file")
  rc=2
fi

exit $rc
