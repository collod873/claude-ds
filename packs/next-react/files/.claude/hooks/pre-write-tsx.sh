#!/usr/bin/env bash
# Tier A scope-gate: fires on any .tsx write outside design-system/
# Stub mode — real checks land post-Slice G when aesthetic-principles skill is wired.
# Rule ID reserved: TSX-000 (used only on hook self-error)
# TODO: post-Slice G, wire aesthetic-principles checks here
set -euo pipefail

file="$1"

# Skip non-.tsx files
case "$file" in
  *.tsx) ;;
  *) exit 0 ;;
esac

# Skip files under design-system/ — those belong to a different Tier
case "$file" in
  *design-system/*) exit 0 ;;
esac

# In-scope .tsx file — stub mode, allow everything until Slice G
exit 0
