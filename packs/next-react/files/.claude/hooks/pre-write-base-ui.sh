#!/usr/bin/env bash
# Opt-in base-ui composition gate (#465). Absorbs crewops's hand-rolled
# base-ui-aschild-validator.sh. base-ui composes via the `render` prop, not
# Radix's `asChild`; a stray `asChild` is a silent no-op on a base-ui part.
# Inert unless the consumer sets componentLib="base-ui" in
# design-system/enforcement.json — Radix consumers (the pack default) are
# never blocked.
# BASEUI-001: asChild prop used under a base-ui scaffold.
set -euo pipefail

source "$(dirname "$0")/lib/read-hook-input.sh"
source "$(dirname "$0")/lib/read-enforcement.sh"
file="$HOOK_FILE_PATH"
if [ -z "$file" ]; then exit 0; fi

# Only active for base-ui consumers.
if [ "$ENF_COMPONENT_LIB" != "base-ui" ]; then exit 0; fi

case "$file" in
  *.tsx|*.jsx) ;;
  *) exit 0 ;;
esac

if enf_is_excluded "$file"; then exit 0; fi
if [ ! -f "$file" ]; then exit 0; fi

rc=0

# BASEUI-001: asChild prop (bare `asChild` or `asChild={...}`).
if grep -nE '\basChild\b' "$file" >/dev/null 2>&1; then
  while IFS=: read -r line _rest; do
    hint="BASEUI-001: asChild is Radix-only; base-ui composes via the render prop (render={<El />})"
    echo "$file:$line: BASEUI-001: $hint" >&2
    bash .claude/hooks/lib/log-failure.sh "BASEUI-001" "$file" "$line" "$hint" || true
  done < <(grep -nE '\basChild\b' "$file")
  rc=2
fi

exit $rc
