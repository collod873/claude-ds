#!/usr/bin/env bash
# PreToolUse / Bash matcher: fires before any bash command.
# Only acts on `git commit` invocations; skips all others.
# Enforces commitlint + runs axe-core WCAG AA scan on changed design-system components.

source "$(dirname "$0")/lib/read-hook-input.sh"
cmd="$HOOK_BASH_COMMAND"

# Skip non-git-commit commands
case "$cmd" in
  "git commit"*) ;;
  *) exit 0 ;;
esac

# Check commitlint is available
if ! command -v commitlint >/dev/null 2>&1; then
  echo "${cmd}:0: COMMIT-000: commitlint not installed (devDependency expected post-Slice F)" >&2
  exit 1
fi

# Parse commit message: look for -m/--message or -F/--file in the command string
commit_msg_file=""
set -- $cmd
shift 2  # drop "git" "commit"
while [ $# -gt 0 ]; do
  case "$1" in
    -m|--message)
      shift
      tmp="$(mktemp)"
      printf '%s' "$1" > "$tmp"
      commit_msg_file="$tmp"
      ;;
    -F|--file)
      shift
      commit_msg_file="$1"
      ;;
  esac
  shift
done

# Fall back to GIT_PARAMS or COMMIT_EDITMSG
if [ -z "$commit_msg_file" ]; then
  commit_msg_file="${GIT_PARAMS:-.git/COMMIT_EDITMSG}"
fi

if ! commitlint --edit "$commit_msg_file" 2>/tmp/commitlint_err.txt; then
  hint="commit message fails commitlint"
  echo "${cmd}:0: COMMIT-001: ${hint}" >&2
  bash .claude/hooks/lib/log-failure.sh "COMMIT-001" "$cmd" "0" "$hint" || true
  exit 2
fi

# Axe-core WCAG AA scan on changed design-system components.
# Finds .tsx files staged under design-system/components/, maps to component names,
# skips any changed .tsx outside the showcase manifest with a warning.
changed_components=""
while IFS= read -r f; do
  # Only care about .tsx under design-system/components/
  if [[ "$f" == design-system/components/*.tsx ]]; then
    # Derive component name: basename without extension
    name="${f##*/}"
    name="${name%.tsx}"
    changed_components="${changed_components}${name} "
  elif [[ "$f" == *.tsx ]]; then
    echo "a11y-scan: WARNING — ${f} is outside design-system/components/, skipping axe scan." >&2
  fi
done < <(git diff --cached --name-only --diff-filter=ACM 2>/dev/null)

if [ -n "$changed_components" ]; then
  # Trim trailing space, split into args
  # shellcheck disable=SC2086
  bash scripts/run-a11y.sh $changed_components
fi

exit 0
