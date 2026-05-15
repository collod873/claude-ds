#!/usr/bin/env bash
# check-hook-contract.sh — CI: scans every .sh in .claude/hooks/ (and subdirs).
# For each hook, asserts that any "exit 2" line is preceded (within the same
# script) by a call to "bash .claude/hooks/lib/log-failure.sh ...".
#
# Emits HOOK-001: <hook> has unguarded exit 2 at line N on violations.
# Exit 0 clean, 2 any violation.
set -euo pipefail

hooks_dir="${1:-.claude/hooks}"
violations=0

while IFS= read -r -d '' hook; do
  in_guard=0
  lineno=0
  prev_had_log=0

  while IFS= read -r line; do
    lineno=$(( lineno + 1 ))

    # Track if a log-failure.sh call appears before the exit 2
    if echo "$line" | grep -qE 'bash[[:space:]]+[^[:space:]]*log-failure\.sh'; then
      prev_had_log=1
    fi

    if echo "$line" | grep -qE '^[[:space:]]*exit[[:space:]]+2[[:space:]]*(#.*)?$'; then
      if [ "$prev_had_log" -eq 0 ]; then
        echo "$hook:$lineno: HOOK-001: unguarded exit 2; precede with bash .claude/hooks/lib/log-failure.sh call" >&2
        violations=$(( violations + 1 ))
      fi
      # Reset guard tracker after each exit 2
      prev_had_log=0
    fi

    # Reset log tracker at function boundaries or blank lines between blocks
    # (simple heuristic: reset if we see a new function or "fi" / "esac" / "done")
    if echo "$line" | grep -qE '^[[:space:]]*(fi|esac|done)[[:space:]]*(#.*)?$'; then
      prev_had_log=0
    fi

  done < "$hook"
done < <(find "$hooks_dir" -name "*.sh" -type f -print0)

if [ "$violations" -gt 0 ]; then
  exit 2
fi
exit 0
