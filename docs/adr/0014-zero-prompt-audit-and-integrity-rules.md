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

Examples: `INTEGRITY-UNPARSEABLE` (file doesn't parse as TS/JSX), `INTEGRITY-ORPHANED-FROM` (`} from` without preceding `import {`), `INTEGRITY-UNRESOLVABLE-IMPORT` (import path doesn't resolve).

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
