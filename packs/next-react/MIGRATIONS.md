# next-react Pack — Migration Map

Path moves and deprecations keyed by version transition. Source of truth: `deprecated_paths` in `manifest.json`.

---

## v0.2.1 → v0.3.0

| Old path (root) | New canonical path | Action |
|---|---|---|
| `contracts.md` | `design-system/contracts.md` | Delete old; `adopt`/`sync` writes new |
| `exceptions.json` | `design-system/exceptions.json` | Delete old; `adopt`/`sync` writes new |
| `failure-log.md` | `design-system/failure-log.md` | Delete old; `adopt`/`sync` writes new |
| `.claude/skills/badge-system/SKILL.md` | _(removed)_ | Delete; Tier-C skill dropped (issue #22) |
| `.claude/skills/typography/SKILL.md` | _(removed)_ | Delete; Tier-C skill dropped (issue #22) |
| `.claude/skills/design-review/SKILL.md` | _(removed)_ | Delete; Tier-C skill dropped (issue #22) |
| `.claude/skills/icons/SKILL.md` | _(removed)_ | Delete; Tier-C skill dropped (issue #22) |

**Automated:** `claude-ds reconcile` will surface these stale paths and offer to delete them (requires v0.5.6+, `reconcile` command from issue #26).

**Manual:** Delete the paths listed above before running `claude-ds doctor` to get a clean bill of health.

---

## v0.3.0 → v0.4.0

No path moves. New files added by `sync`:
- `scripts/` directory (9 scripts seeded)
- `.claude/hooks/lib/log-failure.sh`
- Additional hook verify-fixture files

Run `claude-ds sync` to receive new managed files.

---

## v0.4.0 → v0.5.0

No path moves. `reconform` subcommand added; no migration action required.

---

## v0.5.0 → v0.5.6

No path moves. `generate-showcase.ts` classification changed `seeded` → `managed`; future `reconcile` runs will track it as a managed file.

Run `claude-ds reconform` to refresh showcase stubs with current generator output.

---

## v0.7.7 → v0.7.8

Showcase format finalization (issue #65). No path moves. Five generator changes:

1. **Variants grid renders the full CVA matrix.** No dedup against `meta.examples`. Overlap is intentional — Examples is curated, Variants is exhaustive.
2. **`size: icon*` cells get a lucide `Square` placeholder** when no `children` is supplied. The showcase auto-imports `Square` from `lucide-react`. Consumer must have `lucide-react` installed for any atom with `icon`-prefixed CVA sizes.
3. **Per-cell ✓/⚠/✗ tags are gone**, replaced by a top-of-page `Usage` block with two rows:
   - `✓ Used` — values in the analyzer's `literal` map that exist in the CVA, with counts
   - `✗ Unknown at callsites` — values in `literal` that the CVA does not declare
   The `⚠ Dead in CVA` row is deferred behind a future config flag (defaults off; flip on once the consumer app is ~80% built).
4. **`meta.states` supports new state names:** `disabled`, `hover`, `focus`, `pressed`, `expanded`, `invalid`. Each declared state renders one row in the States section, forced via either a wrapper class (`.force-hover` / `.force-focus`) or an attribute (`disabled` / `aria-pressed="true"` / `aria-expanded="true"` / `aria-invalid="true"`). For wrapper-class states to render visibly, the component's CSS must opt in: rewrite `hover:` / `focus-visible:` rules to `:where(.force-hover, :hover)` / `:where(.force-focus, :focus-visible)`.
5. **`Meta.states` type adds documented fields** for each new state name. TSDoc explains the force mechanism per name.

Run `claude-ds sync` then `claude-ds reconform` (or the `regenerate-companions` hook) to refresh showcases.

---

## v0.6.1 → v0.7.0

No path moves. Two consumer-facing changes:

1. **`@ts-nocheck` removed from generated `.showcase.tsx`.** Consumer must backfill realistic prop values in each `meta.examples[].props` so the generated showcase typechecks against the component's actual prop types. Without backfill, `tsc` will surface real errors instead of silently passing. (Crewops tracks this as #3.)

2. **`Meta.states` is now an optional field** (additive). Consumers may declare:
   ```ts
   states?: {
     loading?:  { name: string; props: Record<string, unknown> };
     longText?: { name: string; props: Record<string, unknown> };
     empty?:    { name: string; props: Record<string, unknown> }; // composites only
   }
   ```
   Each declared state produces a labeled row in the showcase. Omitting `states` leaves the showcase unchanged from prior behavior.

3. **Optional usage-analyzer hook.** If a consumer creates `scripts/analyze-component-usage.ts` exporting a default function with signature
   ```ts
   (srcFiles: string[]) => Map<componentName, {
     literal: Map<prop, Map<value, count>>;
     dynamicProps: Set<prop>;
   }>
   ```
   the generator will load it and render ✓ used / ⚠ dynamic-only / ✗ unused tags per CVA variant. If the file is absent, the tag column is omitted (no failure mode).

Run `claude-ds sync` to pull the updated generator, then `claude-ds reconform` (or the `regenerate-companions` hook) to refresh showcases.
