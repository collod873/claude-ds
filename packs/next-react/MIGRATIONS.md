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
