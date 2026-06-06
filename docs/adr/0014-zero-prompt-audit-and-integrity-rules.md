# ADR-0014: Zero-prompt audit and integrity rules

**Status:** Accepted  
**Date:** 2026-05-27  
**Deciders:** Collin Lodato

## Context

`claude-ds audit --fix` has three compounding problems:

1. **Fixers can break files and audit can't detect the breakage.** The stale-import fixer's dedup logic stripped `import {` openers from multi-line imports, producing syntax errors. Audit declared "No action required" because no rule checks file health — all 13 rules check DS conventions only. The consumer sees a confident success message while their files are broken.

2. **Interactive prompts block non-coder consumers.** Seven scenarios prompt for human judgment using developer jargon ("Extract, convert, or defer domain import?"). A non-coder business owner using AI to build their app cannot answer these questions and gets stuck.

3. **No command tells the consumer what to do next.** After `adopt` succeeds, the consumer must consult the README to learn that `classify` comes next. After `audit --fix` reports "78 fixed," there's no nudge to verify the build still passes.

These problems make brownfield adoption fragile and erode trust in the tool.

## Decision

### Integrity rules

Audit gains a new rule category: `INTEGRITY-*` rules that check structural file health in DS files. These fire **before** convention rules (`DRIFT-*`). If a file fails integrity, convention fixers skip it.

Examples: `INTEGRITY-UNPARSEABLE` (file doesn't parse as TS/JSX), `INTEGRITY-ORPHANED-FROM` (`} from` without preceding `import {`), `INTEGRITY-UNRESOLVABLE-IMPORT` (import path doesn't resolve), `INTEGRITY-UNRESOLVED-SYMBOL` (references a value name it never imports or declares — TS2304/TS2686), `INTEGRITY-DUPLICATE-DECL` (same top-level function implemented twice — TS2393).

Integrity rules follow the same ADR-0013 contract: auto-fix where possible (e.g. restore from git if audit caused the damage), don't flag what you can't help with.

### Fixer output validation

Every fixer parses its output before writing to disk. If the result doesn't parse but the input did, the fixer does not write the broken version. The original file is preserved, and the fixer reports that it could not safely apply the fix. This is prevention — breakage never reaches disk.

### Zero-prompt default

`audit --fix` runs to completion with no interactive prompts. Every ambiguity that currently blocks on a prompt gets a safe automated default:

| Current prompt | Automated resolution |
|---|---|
| Ambiguous tier (unknown) | Classifier decides; if truly unknown, leaf node = atom |
| Feature file in DS directory | Move to `features/`, rewrite imports |
| Multiple token matches | Pick nearest value |
| Raw primitive symbol choice | Pick base atom (Button, Input) |
| Domain import extract/convert | Extract (safe — moves target, doesn't delete) |
| Check-script violation | Register exception with auto-generated reason |
| Confirmation gates (adopt, sync) | Remove; `--dry-run` replaces them |
| Managed file hand-edited | Overwrite and notify; consumer has git history |

### Simple questions for genuine ambiguity

When two options are equally valid and the system's best guess would be wrong often enough to matter, the tool asks — but only if the question passes three tests:

1. A non-coder can understand it without technical context
2. The options are concrete and distinguishable (not jargon)
3. The system's best guess would be wrong often enough to matter

Examples of acceptable questions:
- "This component could be an atom (simple building block) or a composite (combines multiple atoms). Which is it?"
- "This padding is 13px but your tokens have 12 and 14. Which should it be?"
- "Two copies of this file exist with different content. Keep the newer one?"

### Next-step breadcrumbs

Every command prints a "next step" line on completion:
- `adopt` → "Next: run `claude-ds classify --src <dir>` to migrate existing components"
- `classify` → "Next: run `claude-ds audit` to check for drift"
- `audit --fix` → "Next: run your build (`npm run build` / `tsc`) to verify no breakage"

### Unreadable files are bugs

If audit detected a finding on a file, the file was readable at detection time. A fixer failing to read the same file is a bug in claude-ds, not a behavior category. Treat as an assertion failure.

### Brownfield verification asserts the journey, not just the end state

A release candidate is accepted on a brownfield consumer only when the full sequence (`sync → classify → audit --fix → audit`) reaches a clean, idempotent tree in **one human-run pass with zero interventions**. CI green is necessary but not sufficient: static and end-state checks cannot see a self-worsening `--fix`, a relocation that leaves dangling imports, or breadcrumbs that route the consumer in a circle. Those failure modes only surface while the journey is in flight.

Concretely, the bar is:

1. Final `audit` exits 0.
2. `doctor --completeness` exits 0.
3. A second `audit --fix` from the converged state makes 0 changes and 0 new errors (**idempotent**).
4. `tsc --noEmit` shows 0 new unresolved-import errors attributable to the run.
5. **Interventions = 0.** Genuine ambiguity prompts (atom vs. composite, token nudges) are allowed and counted; *corrections* (hand-edits to the consumer, undoing a bad move, stopping a divergent loop) are fails.
6. Classify's scope is honored (`git status` after `classify` shows changes confined to `design-system/` and its manifest).

The result — pass/fail plus the **interventions-required count** — is recorded in `pack/versions/<candidate>/verification.md` and gates the release. The HITL run is the binding acceptance; CI cannot replace it, and no amount of green test suites closes the question. See [ADR-0015](0015-classify-owns-extraction-audit-is-surgical.md) for the structural reason convergence is now achievable.

## Consequences

- Brownfield adoption becomes fully self-service for non-coders: run commands in sequence, follow breadcrumbs, answer occasional plain-language questions.
- Fixer bugs cannot silently corrupt consumer files — output validation catches them before they reach disk.
- Integrity rules close the gap where audit could break files and then declare success.
- The number of interactive prompts drops from ~17 to only genuine ambiguity questions (estimated 2-3 per audit run on a typical brownfield project).
- Existing fixers and detection logic need retrofit. This is incremental per ADR-0013's rollout model.
- `--dry-run` becomes the preview mechanism; confirmation prompts are removed.
- Every release ships with a filled `verification.md` recording the brownfield journey on a real consumer (Crewops baseline today) — pass/fail against the 6-item bar and an explicit interventions-required count. A candidate with non-zero interventions does not ship.

## Amendment (2026-06-05, #259): the compile gate is audit-enforced, not human-run

The original decision placed a `tsc --noEmit` check in the brownfield acceptance bar (item #4) and as a completion breadcrumb ("Next: run your build"). Both are *human-run* — they live outside the tool. #259 showed why that is insufficient: a full heal of Crewops `72c6dde` reached an all-green state (`audit --fix` → fixed point, `doctor --completeness` OK) on a tree that did not compile — 8 atoms with stripped imports and duplicated function bodies. The breadcrumb gate "the HITL never ran," so the false green reached a developer's terminal. The original integrity rules (`UNPARSEABLE`, `ORPHANED-FROM`, `UNRESOLVABLE-IMPORT`) all missed it: the files parse, and they have *zero* imports, so there is no unresolvable import to flag.

The gap is structural: audit's `clean` verdict was backed by **rule-coverage**, not by **resolution**. Any corruption class nobody wrote a rule for scores clean.

The amendment moves the resolve check inside audit:

1. **`INTEGRITY-UNRESOLVED-SYMBOL`** and **`INTEGRITY-DUPLICATE-DECL`** — blocking integrity rules driven by a single-file resolution pass (`src/lib/integrity/resolve-symbols.ts`). A tier file that references a value identifier it never imports or declares, or that implements the same top-level function twice, is now a finding. Because the rules are blocking and (today) non-fixable, audit cannot report a clean fixed point on a tree that will not typecheck.
2. **Scoped resolution, not full `tsc`.** The pass is a value-position free-variable analysis over the single file — no type program, no consumer toolchain. This is deliberate: a real `tsc --noEmit` conflates the consumer's own pre-existing `src/` errors with design-system errors, while the resolution pass stays scoped to `design-system/` and is compiler-*grounded* (resolution, not a regex heuristic) without being noisy. It catches the whole "references a name that isn't there" class, not just the observed signature. It does **not** catch type-level errors; that remains the human `tsc` bar item, now a backstop rather than the only gate.
3. **Extraction refuses a non-resolving parent.** `extract-inline-components` runs the same resolution pass on the parent before lifting a child; a corrupt parent (no imports to carry) would otherwise mint a fresh broken atom (the 8th file, `file-uploader-row.tsx`). Ties the extract guard to the same check as #1.

Re-deriving the missing import closure to *auto-repair* the broken atoms is intentionally out of scope here — guessing a symbol's source module risks writing imports that break a consumer, which violates the north star. Detection + gate kills the false green; repair is a separate, evidence-gated follow-up. The headline defect — audit reporting clean on a non-compiling tree — is closed by detection alone.

## Amendment (2026-06-05, #260/#263/#264): canonical heal sequence requires a second classify pass

After `audit --fix` re-derives the import closure for corrupt atoms, some of those atoms may now compose enough DS components to be correctly classified as composites. Because `classify` ran before `audit --fix` restored the imports (at which point the atom had 0 imports and scored as atom), a second `classify` pass is required for the classification verdict to be correct.

**Canonical brownfield heal sequence (Crewops `72c6dde` and any similar baseline):**

```
claude-ds sync
claude-ds upgrade
claude-ds classify
claude-ds audit --fix
claude-ds classify          ← second pass: relocates atoms that became composites after import restoration
claude-ds audit --fix       ← second fix pass: should be no-op or clean up any remaining findings
```

The first `audit --fix` breadcrumb already routes to `claude-ds classify` when DRIFT-MISPLACED / DRIFT-MISCLASSIFIED-ATOM findings remain — the UX drives the consumer correctly. The second `audit --fix` should be a fixed point (0 changes, 0 errors).

This is not a new prompt or intervention — `classify` auto-relocates confident composites unconditionally (the ambiguity pass in `applyAmbiguityPass`). The consumer follows the breadcrumbs with no judgment required.

## Amendment (2026-06-06, PRD #266): interactive fixer decisions lift out of `plan()`

The original zero-prompt-default rule above said "every ambiguity that currently blocks on a prompt gets a safe automated default." Two fixers (`ds-imports-feature` and `inline-static-style`) didn't actually meet that bar — they still called `opts.prompt(...)` from inside `fix()`, which runs inside `fixerAsOperation.plan()`. Three consequences:

1. A future dry-run path would have *prompted* the user (the opposite of dry-run).
2. The non-TTY shim (`makeNoTtyPrompt`) silently answered option 0 on the user's behalf — a "zero prompts" claim that hid an arbitrary choice rather than recording a deferral.
3. `audit-fix.ts` carried a ~25-line post-hoc cleanup block that existed only because the deferral decision ran inside `plan()` instead of before it.

PRD #266 Phase C closes the gap structurally:

- Every `fixable:true, interactive:true` `DriftRule` exposes a `describeDecisions(finding, source, opts): FixerDecisionPoint[]` hook — a *pure* enumeration of the rule's decision points (no I/O beyond what `detect` already read; no prompting). Forgetting the hook on a new interactive rule is a compile error.
- A command-level pre-pass in `audit-fix.ts` enumerates decision points, asks them via `makeTtyPrompt` (TTY) or records `"defer"` (non-TTY) into `ctx.decisions.fixerChoices`, and routes deferrals to `exceptions.json` — all *before* planning. Non-TTY auto-deferral is explicit (`reason: "auto-deferred: no TTY"`), not silently option 0.
- Fixers read `ctx.decisions.fixerChoices` instead of calling `opts.prompt`. `FixerOpts.prompt`, `makeNoTtyPrompt`, and the post-hoc cleanup block are deleted.
- `tests/unit/no-prompt-inside-rules.test.ts` fails CI on any future `opts.prompt` / `FixerPrompt` import inside `src/lib/drift/rules/`.

The "Simple question test" three-part gate above still binds — it now governs what `describeDecisions` may surface, and the questions are still asked at the command level when a TTY is present. What changed is that planning no longer prompts: `plan(ctx)` is now provably a pure function of `ctx`, the literal statement the `tests/unit/runner.test.ts` capstone pins.
