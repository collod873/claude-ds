---
name: merge
description: Merge open PRs in smart order and pull to local. Use when Collin types /merge to land a batch of agent PRs.
---

# /merge — batch-merge open PRs

Merge all open PRs in smart order, then pull main locally.

## Steps

1. List candidates:
   ```
   gh pr list --repo collod873/claude-ds --state open --json number,title,mergeable,mergeStateStatus,labels
   ```

2. If none found, tell Collin "no open PRs" and stop.

3. Sort order:
   - Mergeable (CLEAN) PRs first
   - Among those, lower PR number first (oldest = fewest potential conflicts)
   - CONFLICTING PRs last (these may resolve after earlier merges land)
   - Skip anything in a non-mergeable state for reasons other than conflicts (e.g. BLOCKED on failing checks or required review) — report it, don't merge.

4. Show the ordered list and confirm: "Merging N PRs in this order — go?"

5. For each PR in order:
   - Check mergeable status: `gh pr view <number> --json mergeable,mergeStateStatus`
   - If CLEAN: `gh pr merge <number> --squash --delete-branch`
   - If CONFLICTING: skip, report it. After all clean ones merge, re-check — the conflict may have been with a PR that just merged. If now clean, merge it. If still conflicting, report to Collin.
   - Brief pause between merges (2s) to let GitHub recalculate merge states.

6. After all merges: `git pull origin main` to sync local.

7. If any merged PR changed files under `src/`, `tsconfig.json`, or `package.json`, run `npm run build` to rebuild the linked CLI.

8. Report: what merged, what's still open, whether a rebuild ran, local status.
