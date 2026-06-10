# 0029 — An empty migration range still advances the pack pin

Date: 2026-06-10
Status: Accepted
Relates to: ADR-0011 (staged migrations, `upgrade`/`repair` split), ADR-0003
(completeness / convergence), #265 (heal fixed point), PRD #529, #531

## Context

Running `npx claude-ds` in Crewops (real consumer, pinned at pack v1.7.0,
healed by CLI v1.8.0) produced a heal run that never converges. The front door
advertised "upgrade available"; `upgrade` ran, printed ✔, and left the pin at
v1.7.0; the next heal pass re-derived "upgrade available" and ran the identical
no-op. Heal burns every pass on the same step and exits at the iteration
ceiling — the deepest violation of the north star (a consumer the tool cannot
drive clean).

The cause is in `upgrade`'s empty-migration-range branch. `computeMigrationChain(from, to)`
returns `[]` when the installed CLI is ahead of the pin but no migration Op is
registered for the gap (the common shape for a release that ships no migration
at its own version). The old branch treated the empty chain as "nothing to do":
it printed `no registered migrations between v1.7.0 and v1.8.0` / `pack is at
v1.7.0`, ran the end-state verification chain, and returned ✔ — **without
moving the pin**. Because `upgradeAvailable` is computed as `pinned < installed`
(`src/lib/project-state.ts`), the pin staying at v1.7.0 means the complaint
that triggered the step is still true after the step succeeds. ✔ with the
originating complaint intact is the loop.

`upgrade.test.ts` pinned "no registered migrations → exit 0" as correct *in
isolation*, so the suite was green through this. The broken behavior only shows
up in the cross-version status → plan → upgrade → convergence combination,
which had no fixture (PRD #529).

## Decision

**An empty migration range is informational, never a blocker. The `upgrade`
step still advances the pack pin to the target (the installed CLI version)
even when no migration Op spans the gap.**

Concretely, in the `chain.length === 0` branch (which is reached only when
`from !== to` — equality is handled earlier), `upgrade`:

1. Runs the end-state verification chain as before (repair of any drifted
   migration `<= from`).
2. Then writes `packVersion = to` (and the auto-detected `allowed_imports`)
   through the Runner via `finalizeUpgrade`, the same finalizer the
   migration-applying path uses.
3. Reports the pin advance (`pin advanced vX → vY (no migrations to apply)`)
   and returns the `applied` verdict.

A `--dry-run` previews this without writing — the pin must not move on a
non-destructive preview.

After the step, `pinned === installed`, so `upgradeAvailable` is false and the
heal loop does not re-plan `upgrade`. The complaint the step was dispatched to
clear is cleared by the step. This is the general rule PRD #529 names for every
step: ✔ requires progress; ✔-with-the-originating-complaint-intact is invalid.

### Safety rationale (the rail PRD #529 left open)

PRD #529 left open whether pin-advance-without-migrations needs a safety rail,
since advancing the pin without running migrations could in principle leave the
consumer's managed files unreconciled. It does not, for two structural reasons:

- **The pin records migration progress only.** Which managed files a consumer
  receives is governed by the installed CLI's manifest and delivered by `sync`,
  not by the `packVersion` field. The pin says "I have reached this migration
  state"; with an empty range there are by definition no migration bytes to
  apply, so advancing the pin changes no managed file.
- **`sync` owns file reconciliation and heal runs it immediately after.** The
  canonical order (ADR-0018) is `upgrade → sync → …`; heal's next step
  reconciles any scaffold gap. The pin advance therefore never needs to deliver
  files itself, which is why this branch deliberately does **not** embed a
  `sync` the way the migration-applying path does (`upgrade.test.ts`: "does not
  auto-sync when no migrations exist for the range" still holds).

This keeps Operations pure planners and the Runner the only writer: the pin
advance is one `finalizeUpgrade` Change through the Runner, no new write path.

## Consequences

- Heal converges on the Crewops v1.7.0 → v1.8.0 journey: `upgrade` advances the
  pin, `upgradeAvailable` clears, and the loop moves on instead of repeating.
- `upgrade`'s empty-range verdict changes from `no-op`/`repaired` to `applied`
  when the pin advances (the `from === to` already-current branch is unchanged —
  there is nothing to advance, so it stays `no-op`/`repaired`).
- This is an ADR-0011-adjacent refinement, not a reversal: ADR-0011's
  `upgrade`/`repair` split (forward-only vs end-state restoration) stands. This
  ADR resolves what the *forward* verb does when the forward gap carries no
  migrations — it still moves the pin forward.
- The front-door / heal commitment-gate header still reads `pin bump only —
  pack stays vX` for an empty chain (ADR-0011 addendum / #412). That wording is
  now literally accurate — it *is* a pin bump with the pack's managed files
  unchanged. Reconciling the gate preview's remaining "pack stays vX"
  phrasing with the executed pin advance is the plan/report-reconciliation
  work (PRD #529 defects 2 & 3), out of scope here.
