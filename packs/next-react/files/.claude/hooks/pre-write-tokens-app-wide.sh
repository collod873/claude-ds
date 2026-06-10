#!/usr/bin/env bash
# Opt-in app-wide token gate (#465). Absorbs crewops's hand-rolled
# ui-token-validator.sh. The DS-scoped pre-write-ds-tokens.sh stays the default;
# this variant fires the same TOK-* family across ALL component files
# (.css/.tsx/.jsx) when the consumer sets tokenScope="app-wide" in
# design-system/enforcement.json. Inert by default — pre-#465 consumers, and
# any consumer left on the default scope, see exit 0 on every file.
# TOK-001 raw color · TOK-002 raw spacing · TOK-003 raw font literals.
set -euo pipefail

source "$(dirname "$0")/lib/read-hook-input.sh"
source "$(dirname "$0")/lib/read-enforcement.sh"
file="$HOOK_FILE_PATH"
if [ -z "$file" ]; then exit 0; fi

# Only active when the consumer opted into app-wide token enforcement.
if [ "$ENF_TOKEN_SCOPE" != "app-wide" ]; then exit 0; fi

# Only component/style files.
case "$file" in
  *.css|*.tsx|*.jsx) ;;
  *) exit 0 ;;
esac

# design-system/** is owned by the DS-scoped hook; tokens.json is the source.
case "$file" in
  *design-system/tokens.json) exit 0 ;;
  *design-system/*) exit 0 ;;
esac

# Consumer-declared exclusions (shadcn ui/, *-pdf.tsx, emails/, globals.css, …).
if enf_is_excluded "$file"; then exit 0; fi

if [ ! -f "$file" ]; then exit 0; fi

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
