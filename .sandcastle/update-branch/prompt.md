# TASK

Update branch `{{BRANCH}}` by rebasing it onto the latest `main`.

# PRE-FLIGHT

Read `CONTEXT.md` if it exists — it contains domain language and architecture decisions.

# STEPS

1. Fetch the latest changes: `git fetch origin main`
2. Rebase the branch onto main: `git rebase origin/main`
3. If there are conflicts:
   - Resolve them carefully, preserving the intent of both sides
   - Read `.sandcastle/CODING_STANDARDS.md` for project conventions
   - Run `npm run typecheck` and `npm run test` after resolving
4. If there are no conflicts, verify the branch still builds and tests pass

## Rules

- Never pipe test or typecheck output through `tail`, `head`, or redirect to a temp file. Run commands directly so streaming output keeps the session alive.
- Never use sleep-loops or polling patterns. Run commands synchronously.

Once complete, output <promise>COMPLETE</promise>.
