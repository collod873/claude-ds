# TASK

Implement the requested changes from PR #{{PR_NUMBER}} review comments.

Pull in the PR details using `gh pr view {{PR_NUMBER}}`.
Pull in the review comments using `gh pr view {{PR_NUMBER}} --comments`.

Work on branch {{SOURCE_BRANCH}}.

# PRE-FLIGHT

Read `.sandcastle/CODING_STANDARDS.md` before starting.

Read `CONTEXT.md` if it exists — it contains domain language and architecture decisions.

# CONSUMER SAFETY

Every change must be safe to drop into any consumer repo without breaking it. The CLI never deletes user content or edits outside its declared ownership.

# CONTEXT

## PR diff

!`gh pr diff {{PR_NUMBER}}`

## Recent commits on this branch

!`git log main..{{SOURCE_BRANCH}} --oneline`

# EXECUTION

1. Read all review comments and requested changes
2. Address each comment — implement fixes, respond to questions
3. Run `npm run typecheck` and `npm run test` before committing
4. Never pipe test or typecheck output through `tail`, `head`, or redirect to a temp file
5. Never use sleep-loops or polling patterns — run commands synchronously

# COMMIT

Make a git commit. Use conventional-commit style messages (e.g. `fix:`, `refactor:`, `test:`).

Include what review feedback was addressed.

Once complete, output <promise>COMPLETE</promise>.
