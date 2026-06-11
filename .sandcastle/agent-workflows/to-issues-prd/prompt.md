# TASK

You are breaking a PRD into a flat list of native GitHub sub-issues. You do
**not** create the issues yourself. You emit a structured plan; the wrapping
script creates and attaches the sub-issues deterministically.

- **PRD:** #{{PRD_NUMBER}} — {{PRD_TITLE}}

# CONTEXT

1. Fetch the PRD:

   ```
   gh issue view {{PRD_NUMBER}} --comments
   ```

   Read it carefully. The PRD is the spec — do not add scope, do not
   redesign. If the PRD is ambiguous, make the most reasonable
   interpretation and proceed; do not stop to ask.

2. Read `CONTEXT.md` and skim `docs/adr/` for any decisions that bear on
   the area the PRD touches. Sub-issue titles and bodies must use the
   project's vocabulary.

3. Explore the codebase to ground the breakdown in the real
   shape of the files you'll be cutting through.

   During exploration, look for opportunities to prefactor the code to
   make the implementation easier. "Make the change easy, then make the
   easy change."

# DRAFTING SUB-ISSUES

Break the PRD into **tracer-bullet** vertical slices. Each slice is a thin
vertical cut through every layer (schema → API → UI → tests), NOT a
horizontal slice of one layer.

Rules:

- Each slice delivers a narrow but COMPLETE path through every layer.
- A completed slice is demoable or verifiable on its own.
- Prefer many thin slices over few thick ones.
- Sub-issues are **flat** — a sub-issue must not itself need sub-issues.
  If a slice is too big to leaf, split it into multiple peer slices.
- Prefactoring should be done before feature work.
- Each slice must stand on its own in a single agent session. A reasonable
  session can build a couple of files, write tests, and run
  typecheck/test. Don't draft slices that are unrealistic for one session.
- **Declare real dependencies explicitly.** For each slice, list which
  earlier slices it genuinely builds on (by their 1-based position in your
  list) via `dependsOn`. This is NOT cosmetic ordering — it becomes a
  native GitHub blocked-by link, and the implement workflow uses it to
  decide what runs. Every slice with an EMPTY `dependsOn` fans out and
  starts in parallel immediately; a slice only waits for the slices it
  actually depends on. A slice depends on another when it can't be built
  until that work lands on the default branch (B imports A's module,
  extends A's schema, calls A's API) — and, per the ladder below, when the
  two slices still touch the same files.

  Shape the chain by this priority ladder, top rule first:

  1. **Slices stay session-sized.** This is a hard ceiling and outranks
     everything below it — never grow a slice past one session to dodge an
     overlap. If respecting the ceiling forces overlap, accept the overlap
     and resolve it with the rules below.
  2. **Remove file overlap before adding an edge.** When two slices would
     touch the same files, first try to redraw the slice boundaries so they
     don't. If they still must, extract a **prefactor slice** that
     restructures the *existing* code so the feature slices stop sharing
     files — and have the feature slices depend on it. A prefactor slice
     restructures existing code ONLY; it never pre-builds scaffolding for
     future slices (that is horizontal layering in disguise). One prefactor
     slice blocking the rest buys full width for one wave of depth.
  3. **A blocker edge covers only the overlap that remains.** Beyond the
     genuine build dependencies above, after repartitioning and
     prefactoring add a `dependsOn` edge solely where two slices still
     touch the same files. Sharing an area of the codebase without editing
     the same files is NOT a dependency — don't add an edge for it, or for
     cosmetic ordering.
  4. **Width is the goal.** A strictly linear result signals the slicing
     failed, not that the overlap rule worked — and a fully linear chain is
     flagged mechanically. Over-declaring serializes work that could run in
     parallel; under-declaring lets two file-overlapping siblings collide.
     Aim for the true graph.

  `dependsOn` may only reference EARLIER positions (a slice cannot depend on
  a later one). Keep the list ordered so this holds.

Draft the ordered list of slices, each with a title, what to build,
acceptance criteria, and its `dependsOn` list.

## HEADLESS-CHECKABILITY GATE

**Every acceptance criterion must be checkable headlessly** — provable by
exit code, `--json` output, a filesystem assertion, or a real run, never by
a human eyeballing the result. This is the repo's verification floor enforced
at the AC level.

Audit each criterion before you emit it:

- A vague criterion ("works correctly," "is robust," "handles errors
  gracefully") is not acceptable. **Rewrite it** into a concrete,
  headless-checkable form — e.g. "handles errors gracefully" → "on malformed
  input, exits non-zero and prints an error to stderr."
- You are headless and **cannot ask the user** — so always rewrite, never
  defer. If a criterion truly resists being made checkable, replace it with
  the closest checkable proxy rather than emitting it vague.
- Do not emit a checklist that mixes checkable and un-checkable items. Every
  item must be one a CI step or a scripted check could tick.

# OUTPUT

Emit the breakdown you just drafted as a single `<output>` block — the last thing in your response. The script parses it with a strict schema.

<output>
{
  "slices": [
    {
      "title": "short imperative title",
      "whatToBuild": "One to three short paragraphs describing this slice's end-to-end behavior, framed around what it delivers. No file paths. Plain text — embed newlines literally as \\n in the JSON.",
      "acceptanceCriteria": [
        "Concrete, checkable outcome 1",
        "Concrete, checkable outcome 2",
        "Tests cover the new behavior"
      ],
      "dependsOn": [1]
    }
  ]
}
</output>

Field rules:

- `slices` — ordered array. The script attaches them in this order under
  the PRD, but execution order is driven by `dependsOn`, not list order:
  every slice with no dependencies starts at once.
- `title` — short, imperative. No leading `feat:` / `fix:` prefix.
- `whatToBuild` — prose, not a list. Avoid specific file paths or code
  snippets. Exception: a prototype-derived snippet (state machine,
  reducer, schema, type shape) may be inlined when prose can't encode the
  decision as precisely.
- `acceptanceCriteria` — array of strings. The script renders them as a
  GitHub checklist (`- [ ] ...`). Always include one item that asserts
  tests cover the new behavior. Every item must be headless-checkable per
  the gate above — rewrite any vague criterion into a concrete, checkable
  form before emitting it; you cannot ask the user, so never emit a vague AC.
- `dependsOn` — array of 1-based positions of EARLIER slices this one is
  blocked by. The script turns each into a native GitHub blocked-by link.
  Omit it or use `[]` for a slice that depends on nothing (it starts
  immediately). Only reference earlier positions; the script rejects a
  forward or self reference.

Do NOT include a `Closes` directive anywhere in the body — the script
omits one by design. Closing sub-issues is the implement-prd workflow's
job; closing the PRD is the merged PR's job.
