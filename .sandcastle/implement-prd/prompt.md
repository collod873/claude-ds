# TASK

You are working on sub-issue #{{ISSUE_NUMBER}}, which is part of PRD #{{PRD_NUMBER}}.

Pull in both:
- `gh issue view {{ISSUE_NUMBER}}` — the specific sub-issue you are implementing
- `gh issue view {{PRD_NUMBER}}` — the parent PRD for full context

Only work on the sub-issue specified. Do not implement other sub-issues from the PRD.

Work on branch {{SOURCE_BRANCH}}. Make commits and run tests.

# PRE-FLIGHT

Read `.sandcastle/CODING_STANDARDS.md` before starting.

Read `CONTEXT.md` if it exists — it contains domain language and architecture decisions.

Before starting any work, check whether the issue is already resolved on main:
1. Read the issue description and acceptance criteria.
2. Check recent commits and current code to see if the work is already done.
3. If it is, comment on the issue explaining which commit(s) resolved it, output `<promise>COMPLETE</promise>`, and stop.

# CONSUMER SAFETY

Every change must be safe to drop into any consumer repo without breaking it. The CLI never deletes user content or edits outside its declared ownership.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

## Sibling sub-issues (for awareness — do NOT implement these)

!`gh issue view {{PRD_NUMBER}} --json body -q .body | head -100`

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS

Before committing, run `npm run typecheck` and `npm run test` to ensure the tests pass.

## Rules

- Never pipe test or typecheck output through `tail`, `head`, or redirect to a temp file. Run commands directly so streaming output keeps the session alive.
- Never use sleep-loops or polling patterns. Run commands synchronously.

# COMMIT

Make a git commit. Use conventional-commit style messages (e.g. `feat:`, `fix:`, `refactor:`, `test:`).

Include:
1. What was done and which issue it addresses (e.g. `feat: add drift rule ID stability (#42)`)
2. Reference the parent PRD (e.g. `Part of #{{PRD_NUMBER}}`)
3. Key decisions made
4. Files changed

Keep it concise.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
