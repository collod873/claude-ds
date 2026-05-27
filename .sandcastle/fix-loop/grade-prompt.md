# TASK

You are an independent grader. Your job is to evaluate whether a single run of
`claude-ds audit --fix` on a consumer repo produced a clean result. You grade
against a 23-item rubric. You do NOT fix anything — only grade.

The mechanical checks have already been run by the workflow. Their output is
captured in log files. Read each one carefully.

# LOG FILES

Read these files using the Read tool:

- **Audit log:** `{{AUDIT_LOG}}`
- **TSC log:** `{{TSC_LOG}}`
- **Build log:** `{{BUILD_LOG}}`
- **Idempotency log (second audit --fix):** `{{AUDIT_IDEMPOTENCY_LOG}}`
- **Readonly audit log (audit without --fix):** `{{AUDIT_READONLY_LOG}}`
- **Crewops design-system directory:** `{{CREWOPS_DS_DIR}}`

For rubric items that require inspecting files (coverage, meta.kind, exceptions),
use the Bash tool to check the crewops checkout at `{{CREWOPS_DIR}}`.

# CONTEXT

Read `CONTEXT.md` and the following ADRs before grading — they define the
standards each rubric item is derived from:

- `docs/adr/0003-completeness-principle.md`
- `docs/adr/0004-design-system-tiers.md`
- `docs/adr/0005-ds-vs-features-boundary.md`
- `docs/adr/0006-three-signal-audit.md`
- `docs/adr/0013-actionable-audit-findings.md`
- `docs/adr/0014-zero-prompt-audit-and-integrity-rules.md`

# RUBRIC (23 items)

Grade each item Y (pass) or N (fail) with a one-line reason.

## Integrity (ADR-0014)

1. `integrity-fixer-validates` — Did every fixer validate its output parses before writing to disk? Check the audit log for any "fixer preserved original" or parse-failure messages. If no such messages appear AND no files were corrupted (item 3), pass.
2. `integrity-rules-first` — Did integrity rules (`INTEGRITY-*`) fire before drift rules? Check the audit log for ordering — integrity findings should appear before `DRIFT-*` findings. If no integrity findings exist, pass (nothing to order).
3. `integrity-no-corruption` — Were zero files left in a state where they parsed before the run but don't parse after? Use `npx tsc --noEmit` output and check for syntax errors in design-system files. Cross-reference with the audit log to see if those files were touched by fixers.

## Coverage (ADR-0006, ADR-0003)

4. `coverage-all-files` — Does every `.tsx` file under `design-system/` appear in audit output (passed, fixed, or question asked)? List all `.tsx` files under `design-system/` in the crewops checkout and verify each appears in the audit log.
5. `coverage-meta-kind` — Does every file under `design-system/` have a `meta.kind` export after the run? Grep for `meta.kind` or `kind:` in meta exports across all `.tsx` files under `design-system/`.
6. `coverage-three-signals` — Were all three signals checked per file (location, self-declaration, classifier truth)? Check the audit log for evidence of three-signal checking. If the audit only reports drift rules (which require signal comparison), this is implicit evidence.

## Ambiguity handling (ADR-0014)

7. `ambiguity-no-jargon` — Were zero developer-jargon prompts shown? Check the audit log for interactive prompts with technical language. Pass if none found.
8. `ambiguity-questions-asked` — Were plain-language questions asked for genuinely ambiguous classifications? Check the audit log for question prompts. On a brownfield codebase, zero questions is suspicious — if zero questions were asked, FAIL and explain that genuine ambiguity likely exists.
9. `ambiguity-no-silent-skip` — Were zero ambiguities silently skipped or auto-resolved without appearing in output? Check whether any files were classified without appearing in the audit log. Cross-reference the file list from item 4.

## Exceptions (ADR-0003, ADR-0013)

10. `exceptions-no-auto-filed` — Were zero new exceptions added to `exceptions.json` that the user didn't explicitly approve via prompt? Diff `exceptions.json` against the baseline (check git diff in the crewops checkout).
11. `exceptions-have-issues` — Do all pre-existing exceptions reference a live upstream issue? Read `exceptions.json` and check each entry has an `issue` field with a GitHub issue reference.

## Drift rules (ADR-0004, ADR-0005, ADR-0006)

12. `drift-atom-imports` — Are atom import predicates enforced? After the fix, no atom should import other atoms, composites, patterns, features/, or lib/. Check the readonly audit log for any `DRIFT-MISCLASSIFIED-ATOM` or import-direction violations on atoms.
13. `drift-composite-imports` — Are composite import predicates enforced? After the fix, no composite should import patterns, features/, or lib/. Check the readonly audit log.
14. `drift-pattern-predicates` — Are pattern predicates enforced? Patterns should export slots and not import other patterns. Check the readonly audit log for `DRIFT-PATTERN-NO-SLOTS` or `DRIFT-PATTERN-IMPORTS-PATTERN`.
15. `drift-ds-imports-feature` — Does `DRIFT-DS-IMPORTS-FEATURE` fire for any DS file importing from `features/` or `lib/`? Check both the fix log (should have been caught) and readonly log (should be zero remaining).
16. `drift-raw-primitive` — Does `DRIFT-RAW-PRIMITIVE` fire for composites hand-rolling `<button>`/`<input>` when atoms exist? Check both the fix log and readonly log.

## Actionability (ADR-0013)

17. `actionability-specific-remediation` — Does every unfixed finding include a specific remediation (not just a category name)? Check the readonly audit log for any remaining findings and verify they include specific instructions.
18. `actionability-no-false-positives` — Were zero unfixable patterns flagged? Check the audit log for findings that flag runtime-dynamic expressions or other patterns that cannot be remediated.

## Build

19. `build-tsc` — Does `tsc --noEmit` exit 0? Check the TSC log for errors. The last line or exit status should indicate success.
20. `build-next` — Does `next build` exit 0? Check the build log for "Compiled successfully" or similar. Check for any error output.

## Idempotency

21. `idempotent-no-changes` — Does a second `audit --fix` (without reset) produce zero changes? Check the idempotency log. It should show "0 fixed" or equivalent — no files should have been modified on the second pass.
22. `idempotent-audit-clean` — Does `audit` (no `--fix`) report zero findings after the fix run? Check the readonly audit log for "0 error" or "No action required" or equivalent. Any remaining findings = fail.

## UX (ADR-0014)

23. `ux-breadcrumb` — Did audit print a next-step breadcrumb on completion? Check the audit log for a "Next:" line at the end.

# GRADING RULES

- Be strict. When in doubt, fail.
- Do not speculate — base every grade on evidence in the logs or files.
- For items where you need to inspect the crewops checkout (coverage, meta.kind, exceptions), use the Bash tool.
- If a log file is empty or missing, that item fails.

# OUTPUT

Emit a single `<output>` block as the **last thing** in your response. The
block must contain valid JSON matching this structure exactly:

<output>
{
  "items": [
    { "id": "integrity-fixer-validates", "pass": true, "reason": "No parse-failure messages in audit log; no corrupted files detected" },
    { "id": "integrity-rules-first", "pass": true, "reason": "No integrity findings to order; all findings are DRIFT-*" },
    ...all 23 items...
  ],
  "score": 21,
  "allPass": false,
  "summary": "21/23 — failing items: build-tsc (258 type errors in design-system files, mostly stale `states` property), idempotent-audit-clean (78 DRIFT-STALE-DS-IMPORT findings remain)."
}
</output>

The `score` must equal the count of items where `pass` is `true`. The `allPass`
must be `true` only when `score` is 23. The `summary` must be 1-3 sentences
naming the failing items and their root causes.
