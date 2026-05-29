# Plan — Issue #200: Tighten ambiguity heuristic to stop prompting for utility-only imports

## Context

Under PRD #196, the `audit` ambiguity heuristic asks "this file is in `atoms/` but imports
N other components — atom or composite?". On the crewops baseline it fired **28 prompts** in
one run; the PRD target is ~2–3 (verified by sibling HITL issue #201).

Root cause (`src/commands/audit.ts:381-393`): the count treats **any** relative import as a
"component". `button.tsx` imports `cn`, `cva`, and shadcn helpers — none are components — yet
counts as 3 and trips the threshold. A JSX-uppercase fallback (`<Slot>`, etc.) overcounts the
same way. Dependency #198 (Delete Path B) is already closed, so this is unblocked.

The fix: count only imports that resolve to a design-system tier file (atom/composite/pattern).
The project already has the correct logic — it just isn't reused here.

## Reusable code found (do not re-roll regex)

- `src/lib/classifier.ts:38` `countDistinctDsComponentImports(source, dsAliases)` — counts
  distinct imports matching `design-system/(atoms|composites)/`. Currently **not exported**;
  used internally by `classifySource`. This is the exact "real DS component import" count #200
  asks for. The audit heuristic re-rolled a broader, buggy version instead of importing this.
- `src/lib/classifier.ts:20` `buildDsComponentImportRe` / `:11` `DS_COMPONENT_IMPORT_RE` — the
  alias-aware regexes backing the helper.

## Implementation steps

- [ ] **Export a DS-component-import count helper from `classifier.ts`.** Export the existing
  internal `countDistinctDsComponentImports` (or a thin wrapper) under a clear public name, and
  extend its regex to `(?:atoms|composites|patterns)` since #200 spec says atom/composite/pattern.
  Keep `classifySource`'s own behaviour unchanged (its composite predicate must still count
  atoms/composites only — verify by running the suite, or give it its own private call).
  **Files:** `src/lib/classifier.ts`
  **Scope:** add/export one counting function; do not alter `classifySource`'s tier verdicts.

- [ ] **Replace the audit heuristic body with the exported helper.** Swap the `relativeImports` +
  `dsImports` + `jsxComponents` `Math.max` computation (lines ~384-389) for a single call to the
  exported count. Drop the relative-import catch-all and the JSX-uppercase fallback entirely.
  Keep the `>= 3` threshold and the existing `locationTier === "atom"` + `!DRIFT-MISPLACED` guard.
  **Files:** `src/commands/audit.ts`
  **Scope:** only the ambiguity-count block (~lines 381-393); leave the prompt loop and breadcrumb untouched.

- [ ] **Add count-helper unit tests** per #200 acceptance criteria, asserting on the exported
  count function (testable in isolation, no TTY): utility-only atom (`cn`/`cva`/types/hooks/
  external) → `0`; fixture importing multiple real DS components → ≥ threshold; each canonical
  shadcn atom shape (`button`, `badge`, `input`, `checkbox`, `radio`, `tag`, `tabs`, `tooltip`) → `0`.
  **Files:** `tests/unit/classifier.test.ts`
  **Scope:** new `describe` block using the existing inline source-string + vitest fixture pattern.

## Known consequence to flag (not a blocker)

After this fix the *end-to-end* audit prompt will fire near-**zero** times, by design:
- A file importing ≥1 real DS component → `classifySource` returns `composite`/`unknown` →
  `DRIFT-MISPLACED` fires (`drift-rules.ts:134`) → the ambiguity guard
  (`audit.ts:383`, `!findings.some(DRIFT-MISPLACED)`) **suppresses** the prompt.
- A file with 0 DS-component imports → count `0` → below threshold → no prompt.

So real-DS-import files are already handled deterministically by `DRIFT-MISPLACED`; the prompt
correctly stops firing on the utility-only false positives. This satisfies #201's ≤3 target.
The prompt's broader role is being relocated by sibling issue **#203** (move ambiguity prompts
into `classify`); exporting the corrected count here is exactly what #203 will carry over. The
#200 acceptance tests are unit tests on the count function, which pass regardless of the guard.

## Files to modify

- `src/lib/classifier.ts` — export/extend the count helper.
- `src/commands/audit.ts` — replace heuristic body (lines ~384-389).
- `tests/unit/classifier.test.ts` — add count-helper unit tests.

## Verification

1. `npm run build` (global CLI picks up `src/` only after build).
2. `npx vitest run tests/unit/classifier.test.ts` — new tests green.
3. `npx vitest run` — full suite stays green (no regression in `classifySource` or audit tests).
4. Optional sanity: run `claude-ds audit` against a fixture atom that imports only `cn`/`cva`
   and confirm no ambiguity prompt. (Full crewops ≤3-count proof is sibling HITL issue #201,
   out of scope here.)

## Out of scope

- Moving ambiguity prompts into `classify` (#203).
- The answers-overridden bug (#206).
- The crewops HITL count verification run (#201).
- Inline-component extraction (#202).

## Audit Notes

- **Reuse over re-roll:** the whole point is to stop the audit heuristic from re-implementing a
  broader, buggy import count and instead reuse the project's existing, correct
  `countDistinctDsComponentImports` (`classifier.ts:38`). No new regex.
- **Risk — touching the shared helper:** extending the helper's regex to include `patterns/` and
  exporting it must not change `classifySource`'s tier verdicts. Mitigation: keep
  `classifySource`'s composite predicate counting atoms/composites only, and rely on the full
  vitest suite to catch any drift. If isolation is cleaner, add a separate exported function
  rather than mutating the one `classifySource` uses.
- **Reachability is intentional, not a regression:** after the fix the end-to-end prompt fires
  ~zero times because real-DS-import files are already caught by `DRIFT-MISPLACED` and
  utility-only files now count `0`. This is the desired 28→≤3 drop, not dead code. #200's tests
  target the count function directly, so they pass independent of the guard. #203 relocates the
  prompt where the corrected count becomes meaningful again.
- **Dependency #198 closed**, so this is unblocked. No new deps introduced.
- **Threshold unchanged (`>= 3`):** not re-litigated here; lowering it is a separate decision.
