# TASK

You are running the daily architecture-review pass. Find one fresh deepening
opportunity in this codebase and emit it as a structured proposal.

This is an unattended CI run. There is no user to grill, no HTML report to
write. Your job is:

1. List prior proposals labelled `source:architecture-review` (open and
   closed) so you don't re-propose them.
2. Explore the codebase.
3. Pick **one** top candidate.
4. Emit it as the structured `<output>` (status `proposed`, with the PRD
   title/body) and stop.

Do **not** publish the issue or apply any label yourself. The workflow reads
your `<output>` and handles creating the PRD issue and labelling it. Calling
`/to-prd-project` here would create a duplicate.

The full process — including the methodology (deletion test, deepening,
glossary), the loose-duplicate rule, the PRD shape, and the exact `<output>`
schema — is documented in the project skill
`improve-codebase-architecture-project`. Follow it.

# CONTEXT

Read `CONTEXT.md` and any relevant ADRs under `docs/adr/` before proposing
anything. Treat ADRs as binding — do not propose changes that contradict a
recorded decision.

# RULES

- Read-only on the repo. No commits, no issue creation, no labelling, no
  edits to `CONTEXT.md`, ADRs, or source files. Your sole output is the
  structured `<output>` — the workflow performs every mutation.
- One PRD per run. If every reasonable candidate is already covered by a
  prior `source:architecture-review` proposal, emit a `skipped` output and
  stop.
- No questions to a user — there is none. Make the call.
