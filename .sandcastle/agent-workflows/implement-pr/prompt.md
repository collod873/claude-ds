# TASK

Address unresolved review feedback on PR #{{PR_NUMBER}} on branch `{{BRANCH}}`.

PR title: {{PR_TITLE}}
Linked issue: #{{ISSUE_NUMBER}} {{ISSUE_TITLE}}

This is not a fresh review. Focus on the PR conversation and unresolved feedback.

# LINKED ISSUE

{{LINKED_ISSUE}}

# CURRENT DIFF TO MAIN

```diff
{{DIFF_TO_MAIN}}
```

# PR COMMENTS

```json
{{PR_COMMENTS_JSON}}
```

# PROCESS

For each actionable comment or unresolved thread:

- Change code when the reviewer is right.
- Reply when a reply adds useful context.
- Decline clearly when the requested change is wrong or out of scope.
- Ignore stale/context-only comments.

Run `npm run typecheck` before committing. Run focused tests where relevant.

If you change code, commit with a conventional commit message.

# COMMIT DISCIPLINE

These three rules govern every commit and any hook you hit:

1. **Lint-fix before committing.** Run the project's lint-fix (auto-format) on the files you changed before you commit, so format violations are unrepresentable rather than diagnosed after the fact.
2. **Diff-scoped triage before any "pre-existing" claim.** Before you attribute an error to pre-existing code, run error-level diagnostics scoped to your own diff (lint/typecheck the files you changed). Grepping summary or count lines to decide blame is forbidden — a summary-grep once misattributed an agent's own format error as pre-existing and dead-ended the run after 100% of the work was done.
3. **No-verify on a confirmed pre-existing error.** If a commit or push hook blocks on an error you have confirmed via diff-scoped diagnostics is pre-existing and not introduced by your diff, bypass the hook (`git commit --no-verify`) and let PR CI be the gate. Never dead-end at the hook.

# CONSTRAINTS

Do not push.
Do not edit labels.
Do not resolve review threads.
Do not create GitHub comments yourself.

When complete, output `<promise>COMPLETE</promise>`.
