# TASK

Merge the following branches into the current branch (`main`), then verify and push.

{{BRANCHES}}

# MERGE

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
3. After resolving conflicts (or if none), continue to the next branch

After all branches are merged, make a single commit summarizing the merge if needed.

# VERIFY (HARD GATE)

Before pushing or closing anything, run:

1. `npm run build`
2. `npm run typecheck`
3. `npm run test`

**If any of these fail**: do NOT push, do NOT close issues. Instead:
- Leave a comment on each affected issue describing what failed and what you tried
- Output `<promise>COMPLETE</promise>` and stop

If all three pass, continue.

# PUSH

Run `git push origin main` to publish the merged commits to GitHub.

# CLOSE ISSUES

Only after a successful push, close each merged issue:

`gh issue close <id> --comment "Completed by Sandcastle"`

Here are all the issues:

{{ISSUES}}

Once you've merged, verified, pushed, and closed everything, output <promise>COMPLETE</promise>.
