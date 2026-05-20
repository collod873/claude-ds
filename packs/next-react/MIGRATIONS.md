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
