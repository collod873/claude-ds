#!/usr/bin/env bash
# PreToolUse / Bash matcher: fires before any bash command.
# Only acts on `git commit` invocations; skips all others.
# Enforces commitlint if installed.
# TODO: post-Slice F, add axe scan on changed .tsx files

cmd="${CLAUDE_BASH_COMMAND:-${1:-}}"

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

exit 0
