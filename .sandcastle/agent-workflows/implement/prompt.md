# TASK

Implement issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

You are on branch `{{BRANCH}}`, already created from `main`.

# ISSUE

{{ISSUE_CONTEXT}}

# CONTEXT

Read the project's domain and architecture docs before changing code:

- `CONTEXT.md`
- `docs/adr/` if relevant
- `.sandcastle/CODING_STANDARDS.md`

Explore the repo and relevant tests before editing.

# EXECUTION

Use red-green-refactor where applicable:

1. RED: write a failing test
2. GREEN: implement the smallest correct change
3. REPEAT until the issue is done
4. REFACTOR

Run `npm run typecheck` before committing. Run focused tests where relevant.

## Execution discipline

- Run every command in the **foreground** and wait for it to finish. The full
  test suite (`npx vitest run`) completes in well under a minute — run it inline.
- **Never** background a command and then poll or busy-wait on it (e.g.
  `cmd & while ps -p $!; do sleep 10; done`). A long, silent background command
  produces no stdout and trips the harness idle-timeout, which kills this run
  before your commits can be pushed — losing all your work (#381).
- Keep output flowing: if a step is slow, run it directly so its stdout streams.

# COMMIT

Make one or more commits on `{{BRANCH}}` with conventional commit messages.

Do not push the branch.
Do not close the issue.
Do not edit labels.
Do not create or edit PRs.

When complete, output `<promise>COMPLETE</promise>`.
