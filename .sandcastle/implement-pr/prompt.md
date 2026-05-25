# TASK

You are addressing reviewer feedback on PR #{{PR_NUMBER}} (branch `{{BRANCH}}`).

Unlike a review, your job is **not** to compare the code against a spec or coding standards. Your job is to read the unresolved conversation on this PR, decide what (if anything) to change in the code, make those changes, and explain yourself by commenting back where useful.

# CONTEXT

Read `CONTEXT.md` and any relevant ADRs under `docs/adr/` if you need domain context for a comment. Don't go deeper than the comments demand.

Every change must be safe to drop into any consumer repo without breaking it. The CLI never deletes user content or edits outside its declared ownership.

<linked-issue>

{{ISSUE_BODY}}

</linked-issue>

<diff-to-main>

!`git diff main..HEAD`

</diff-to-main>

<pr-comments>

The unresolved conversation on this PR. Tagged by surface:

- `issue_comment` — top-level PR conversation comment.
- `review_thread` — inline thread anchored to a file + line. Only **unresolved** threads are included. Each comment has a `commentId` you can reply to in-thread.
- `review_summary` — top-level body of a submitted review.

Not everything in here is necessarily actionable — reviewers may leave context, questions, asides, or things they meant to resolve. Use your judgement. **Do not treat unresolved == must-action.**

```json
{{PR_COMMENTS_JSON}}
```

</pr-comments>

# PROCESS

1. Read the conversation. For each item, classify it in your head as: code change needed, reply needed (question / disagreement / clarification), or neither.
2. Make the code changes you decided on. Run `npm run typecheck` and `npm run test` before committing. Use conventional-commit messages (`feat:`, `fix:`, `refactor:`, etc.).
3. If you made no changes that's fine — only commit when there's a real diff.
4. Emit the structured output below describing the replies and any new inline comments you want posted.

You do not have to reply to every thread. Reply only where a reply adds value: confirming what you changed, explaining why you chose not to make a requested change, answering a question, or pointing out something the reviewer should look at. Silence is fine for context-only comments.

You cannot resolve threads. Resolution is the reviewer's job.

# OUTPUT

Emit a single `<output>` block as the **last thing** in your response. Valid JSON, field names exact.

## Example

<output>
{
  "threadReplies": [
    {
      "commentId": "PRRC_kwDOPSEf9c8AAAABX1234",
      "body": "Good catch — fixed in the latest commit by adding the early-return guard."
    },
    {
      "commentId": "PRRC_kwDOPSEf9c8AAAABX5678",
      "body": "I'd push back on this one — renaming `calcVal` to `calculateDiscount` would conflict with the `calcVal` convention used elsewhere in this file. Happy to do it as a follow-up across the whole file if you want."
    }
  ],
  "newInlineComments": [
    {
      "path": "app/services/auth.ts",
      "line": 87,
      "body": "Heads up — while addressing the thread above I also tightened the guard on line 85. Flagging in case it affects the test you mentioned."
    }
  ],
  "topLevelComments": [
    {
      "body": "Addressed 2 of 3 threads. Left the third (about the helper rename) for a separate PR — explained inline."
    }
  ]
}
</output>

## Empty output (rare)

If you made no code changes and have nothing to say, emit:

<output>
{ "threadReplies": [], "newInlineComments": [], "topLevelComments": [] }
</output>

The workflow will mark the run as blocked if both the diff and all reply arrays are empty — that's a degenerate run.

## Field reference

| Field                       | Type    | Required | Notes                                                                                                         |
| --------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `threadReplies`             | array   | no       | Replies posted in an existing unresolved review thread.                                                       |
| `threadReplies[].commentId` | string  | **yes**  | Must be a `commentId` from a `review_thread` in `<pr-comments>`. Do not invent IDs.                           |
| `threadReplies[].body`      | string  | **yes**  | Markdown reply.                                                                                               |
| `newInlineComments`         | array   | no       | New inline comments on lines in the diff (not replies). Use only when a thread reply isn't the right surface. |
| `newInlineComments[].path`  | string  | **yes**  | Relative file path.                                                                                           |
| `newInlineComments[].line`  | integer | **yes**  | Single line number in the post-commit HEAD. The workflow drops anchors that aren't in the diff.               |
| `newInlineComments[].body`  | string  | **yes**  | Markdown.                                                                                                     |
| `topLevelComments`          | array   | no       | New top-level PR conversation comments. Use for cross-cutting summaries or comments not tied to a thread.     |
| `topLevelComments[].body`   | string  | **yes**  | Markdown.                                                                                                     |

Do not add fields not listed above.
