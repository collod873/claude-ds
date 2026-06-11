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

Where a test seam already exists, or a new one is being proposed, do red-green-refactor:

1. RED: write a failing test
2. GREEN: implement the smallest correct change
3. REPEAT until the issue is done
4. REFACTOR

Do not improvise new test seams, such as extracting out a function so that it can be tested in isolation. This creates spaghetti tests.

Run `npm run typecheck` before committing. Run focused tests where relevant.

# COMMIT DISCIPLINE

These three rules govern every commit and any hook you hit:

1. **Lint-fix before committing.** Run the project's lint-fix (auto-format) on the files you changed before you commit, so format violations are unrepresentable rather than diagnosed after the fact.
2. **Diff-scoped triage before any "pre-existing" claim.** Before you attribute an error to pre-existing code, run error-level diagnostics scoped to your own diff (lint/typecheck the files you changed). Grepping summary or count lines to decide blame is forbidden — a summary-grep once misattributed an agent's own format error as pre-existing and dead-ended the run after 100% of the work was done.
3. **No-verify on a confirmed pre-existing error.** If a commit or push hook blocks on an error you have confirmed via diff-scoped diagnostics is pre-existing and not introduced by your diff, bypass the hook (`git commit --no-verify`) and let PR CI be the gate. Never dead-end at the hook.

# COMMIT

Make one or more commits on `{{BRANCH}}` with conventional commit messages.

Do not push the branch.
Do not close the issue.
Do not edit labels.
Do not open or edit the PR yourself — the workflow opens it mechanically from
the metadata you emit below.

# OUTPUT

When the implementation is complete, emit a single `<output>` block as the
**last thing** in your response. Write it from the context you already have —
you just did this work, so summarise it; do not re-read the diff.

<output>
{
  "prTitle": "feat: short imperative summary",
  "prDescription": "## Summary\n\n- bullet 1\n- bullet 2\n\nCloses #{{ISSUE_NUMBER}}"
}
</output>

- `prTitle` must be a single line, under 70 characters, conventional-commit
  style (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).
- `prDescription` must include `Closes #{{ISSUE_NUMBER}}` so the PR closes the
  issue on merge.
