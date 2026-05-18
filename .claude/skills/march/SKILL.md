---
name: march
description: Drive a GitHub meta closure-index issue to completion. Dispatches one sonnet subagent per child issue, watchdog via Monitor, verifies + closes + updates the index per issue, hard-stops on ambiguity or consumer-testing needs. Use when Collin types /march in claude-ds to bang out the rest of a milestone hands-off.
---

# /march — closure-chain orchestrator

You are driving a GitHub meta issue (a "closure index") to completion. Each child issue gets one fresh sonnet subagent. You verify and close as you go. Run AFK; only stop for genuine HITL needs.

## Quick start

1. Find the meta closure index (§0) — or use the issue number Collin passed as arg.
2. For each unchecked child issue in order: dispatch sonnet sub + watchdog (§1), verify (§2), close + tick the index (§3).
3. Stop only on hard-stops (§4). Final summary on exit (§5).

## 0. Find the index

If a meta issue number was passed as arg, use it. Otherwise:
`gh issue list --repo collod873/claude-ds --search "META in:title" --state open` — pick the most recent.

Read its body. The "Closure order" section is your worklist. Items marked `~~...~~ ✅` are done.

## 1. Per-issue loop

For each unchecked item in order:

1. **Read the issue** in full: `gh issue view <N> --repo collod873/claude-ds`.
2. **Dispatch sonnet sub (background) with this prompt skeleton:**

   > You're in `/Users/collinlodato/Claude Projects/claude-ds` on `main`. Implement GH issue #<N>. Read it with `gh issue view`. Also read `CLAUDE.md` at repo root.
   >
   > **Constraints:**
   > - Stay strictly in #<N> scope. Don't touch sibling issues in the same milestone.
   > - Work on `main`. No feature branches. Post-commit hook auto-pushes.
   > - `dist/` is committed — rebuild before committing.
   > - Quote each acceptance-criteria line from the issue and show the command output proving it.
   > - **Hard-stop and report** if you hit a judgment call that affects sibling issues in the same milestone, or any ambiguity the issue doesn't resolve. Do NOT guess.
   > - Budget ~15 min. If you're not done, stop and report partial state.
   > - User prefs: terse, no emojis, evidence over assertions, no scope creep.

3. **Same response, launch heartbeat watchdog:**
   - Bash run_in_background: `for i in 1 2 3; do sleep 300; echo "tick $i $(date +%H:%M:%S)"; done`
   - Attach `Monitor` to that bash process.
4. **On each tick**: `TaskGet` the subagent. If output is progressing, ignore. If stalled (no new output for two ticks), `TaskStop` it and escalate to user.
5. **On subagent completion notification**: kill the heartbeat bash, then verify (§2).

## 2. Per-issue verification (mandatory before closing)

Quick probes — run them all:

- `git -C "/Users/collinlodato/Claude Projects/claude-ds" log --oneline -3 main` — confirm commit on main.
- `git -C "..." diff HEAD~1 HEAD --stat | grep -E '^\s*dist/'` — if any `src/` changed, `dist/` must have changed too. If not, subagent forgot rebuild → reject.
- `cd "..." && npm test --silent 2>&1 | tail -5` — must be green.
- For issues touching consumer-facing UI (routes, gating, rendered output): you cannot autoverify. **Escalate to user** for crewops spot-check.

If any check fails → reopen subagent context via SendMessage with the specific failure, do NOT just close the issue.

## 3. Close + update index

When verification passes:

1. `gh issue close <N> --repo collod873/claude-ds -c "<one-line summary>"`.
2. Edit the meta issue body: strike the line through and append ✅. Use `gh issue view <META> --json body -q '.body'` → edit → `gh issue edit <META> --body-file`.
3. Move to the next item.

## 4. Hard stops (escalate to user, don't proceed)

Stop and ping Collin in plain text when:
- Subagent reports cross-issue ambiguity or asks for a decision.
- Verification fails twice on the same issue.
- Next issue requires a real consumer project to test (anything user-visible at runtime — route rendering, env-var gating, integration migrations).
- The meta issue body is in a state you don't understand.
- Anything genuinely surprising.

## 5. Exit

When the closure index has nothing left unchecked, post a final summary: issues closed, commits on main, anything deferred or flagged.

## Notes

- Do **not** use feature branches. Repo policy is commit-to-main (see `CLAUDE.md`).
- Do **not** open PRs.
- Subagent failures are observable: foreground would block you; background + Monitor heartbeat is the design.
- One subagent at a time. The chain is serial by design — issues depend on prior ones.
