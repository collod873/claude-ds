# TASK

You are fixing claude-ds so that `claude-ds audit --fix` produces a clean pass
on a consumer repo. This is iteration **{{ITERATION}}** of a fix loop for
issue #{{ISSUE_NUMBER}}.

An independent grader just scored the latest run. Here is the scorecard:

```json
{{SCORECARD_JSON}}
```

Your job: fix the **failing items only** by modifying claude-ds source code.
Do not touch crewops. The consumer repo is read-only context — the logs below
show what happened when audit ran there.

# LOG FILES

These are available at the paths below. Read only the ones relevant to the
failing rubric items:

- **Audit log:** `{{AUDIT_LOG}}`
- **TSC log:** `{{TSC_LOG}}`
- **Build log:** `{{BUILD_LOG}}`
- **Idempotency log:** `{{AUDIT_IDEMPOTENCY_LOG}}`
- **Readonly audit log:** `{{AUDIT_READONLY_LOG}}`

# CONTEXT

Read `CONTEXT.md` and any relevant ADRs under `docs/adr/` before starting.
The ADRs define the standards the rubric is derived from — your fixes must
comply with them.

Key ADRs for this work:
- `docs/adr/0003-completeness-principle.md` — completeness, exception discipline
- `docs/adr/0004-design-system-tiers.md` — tier predicates
- `docs/adr/0005-ds-vs-features-boundary.md` — DS vs features boundary
- `docs/adr/0006-three-signal-audit.md` — three-signal audit, classify flow
- `docs/adr/0013-actionable-audit-findings.md` — actionable findings contract
- `docs/adr/0014-zero-prompt-audit-and-integrity-rules.md` — zero-prompt, integrity rules, fixer validation

# EXECUTION

1. Read the failing rubric items and their reasons.
2. Read the relevant log files to understand the specific failures.
3. Explore the claude-ds source to find the code responsible.
4. Make targeted fixes. Do not refactor unrelated code.
5. Run `npm run typecheck` and `npm run test` in the claude-ds repo before committing.
6. Both must pass. If a test fails because of your change, fix the test to match the new correct behavior — do not revert your fix.

# CONSTRAINTS

- **Fix claude-ds, not crewops.** The consumer logs are evidence of what's wrong; the source of every fix is in this repo.
- **Targeted fixes only.** Each commit should address specific failing rubric items. Don't bundle unrelated changes.
- **No exceptions.** Do not add skip logic, ignore flags, or exception-filing as a fix. The audit must genuinely handle the case.
- **Consumer safety.** Every change must be safe to drop into any consumer repo without breaking it (north star from CLAUDE.md).

# COMMIT

Make one or more git commits on `{{BRANCH}}`. Use conventional-commit messages
(`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).

Include `Part of #{{ISSUE_NUMBER}}` in each commit body.

Do not close the issue yourself. Do not push the branch.
