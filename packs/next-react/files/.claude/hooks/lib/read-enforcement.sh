#!/usr/bin/env bash
# Reads the consumer-editable design-system/enforcement.json (#465) and exposes:
#   ENF_TOKEN_SCOPE   "design-system" (default) | "app-wide"
#   ENF_COMPONENT_LIB "radix" (default) | "base-ui"
#   ENF_EXCLUDE[]     glob patterns whose matches are skipped by app-wide gates
#   enf_is_excluded <path>  → 0 (true) when <path> matches any ENF_EXCLUDE glob
#
# The file is seeded on adopt and freely edited by the consumer. When it is
# absent (every pre-#465 consumer) the defaults keep all opt-in enforcement
# inert, so sourcing this never newly blocks a file — "never break a consumer".

ENF_TOKEN_SCOPE="design-system"
ENF_COMPONENT_LIB="radix"
ENF_EXCLUDE=()

_enf_file="design-system/enforcement.json"
if command -v jq >/dev/null 2>&1 && [ -f "$_enf_file" ]; then
  ENF_TOKEN_SCOPE="$(jq -r '.tokenScope // "design-system"' "$_enf_file" 2>/dev/null || echo "design-system")"
  ENF_COMPONENT_LIB="$(jq -r '.componentLib // "radix"' "$_enf_file" 2>/dev/null || echo "radix")"
  while IFS= read -r _pat; do
    [ -n "$_pat" ] && ENF_EXCLUDE+=("$_pat")
  done < <(jq -r '.appWideExclude[]? // empty' "$_enf_file" 2>/dev/null)
fi
unset _enf_file _pat

# enf_is_excluded <path> — true when the path matches an appWideExclude glob.
# `**` is treated as `*` (bash `*` already spans `/`); each pattern is tried
# both anchored and with a leading `*/` so `emails/**` matches a nested path.
# A leading `**/` must also match ZERO directories (glob semantics), so the
# remainder is tried anchored too — `**/*-pdf.tsx` matches a top-level
# `invoice-pdf.tsx`, not just `src/invoice-pdf.tsx`.
enf_is_excluded() {
  local f="$1" p g
  for p in ${ENF_EXCLUDE[@]+"${ENF_EXCLUDE[@]}"}; do
    [ -z "$p" ] && continue
    # $g is an intentional glob on the right-hand side of ==.
    if [[ "$p" == '**/'* ]]; then
      g="${p#\*\*/}"; g="${g//\*\*/*}"
      # shellcheck disable=SC2053
      if [[ "$f" == $g ]]; then return 0; fi
    fi
    g="${p//\*\*/*}"
    # shellcheck disable=SC2053
    if [[ "$f" == $g || "$f" == */$g ]]; then
      return 0
    fi
  done
  return 1
}
