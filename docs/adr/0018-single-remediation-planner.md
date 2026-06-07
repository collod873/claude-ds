# 0018 — One remediation brain: front door and `heal` are two drivers of one planner

Date: 2026-06-07
Status: Accepted
Amends: ADR-0014 (next-step breadcrumb), ADR-0016 (decision kinds), ADR-0003 (heal convergence)

## Context

Crewops v1.2.0 testing exposed that the front-door UX survives exactly one
keystroke. `npx …` renders the dashboard, `[Enter]` dispatches **one**
recommended command in-process (`offerEnterToDispatch`, `front-door.ts:210`),
then the process exits — dropping the user back to a bare shell holding the
sub-command's `→ Next: <type this>` breadcrumb. Nothing re-renders the
dashboard, nothing says "run the door again." The pleasant `[Enter]`-to-run
model collapses into hand-typing `claude-ds` commands — the precise toil the
tool exists to remove (north star: *remember as little as possible*).

Three friction symptoms share this one root:

1. **Single-shot, not a loop.** The front door fires once and abandons the
   user mid-workflow.
2. **Two breadcrumb UIs that don't compose.** The dashboard offers
   `[Enter] to run`; every sub-command prints `→ Next: <type this>` prose.
   After step one you fall out of the good one into the typing one.
3. **The recommendation order is wrong.** `recommendNextStep`
   (`dashboard.ts:64`) ranks `upgrade` **second-to-last** (rank 6 of 7),
   beneath `sync`, `reconcile`, `classify`, and `audit --fix` — while its own
   comment claims to *"mirror the ADR-0003 heal-loop ordering
   (sync → upgrade → classify → audit)."* The code contradicts the comment.
   Convention work (`classify`, `audit --fix`) run **before** an upgrade is
   wasted: the migrations are about to rewrite the very tree that work
   operated on. The user is told to upgrade last, when it should be first.

The deeper cause is **two brains**. `heal` (ADR-0003) is a loop that converges
a project to clean. The front-door dashboard is a *flat, single-shot
re-implementation* of heal's ordering — and it diverges from heal and gets
the order wrong. Duplicated ordering logic, two sources of truth, one of them
broken.

A related smell sharpened the diagnosis: `sync` is **version-blind** — it
writes the installed CLI's pack files (`ctx.packDir`) regardless of the
consumer's pinned `packVersion`. So `sync`-before-`upgrade` drops
latest-version files onto a not-yet-migrated tree. `upgrade` (run migrations +
bump the pin) is the authoritative version transition and should lead; `sync`
reconciles managed-file content afterward. The order is not wrong by accident;
it was under-specified, and only a loop that re-evaluates can thread the edge
cases (e.g. a migration that needs scaffold present, or classify needing two
passes — ADR-0015).

## Decision

**There is one remediation brain, exposed through two drivers.**

A single shared planner computes the **Remediation plan** from project state:
the ordered sequence of commands that drives a not-clean project toward clean.
The canonical order is

```
upgrade → sync → repair → migrate-layout → reconcile → classify → reconform → audit --fix
```

run **to a fixed point** (repeat until an iteration produces 0 file changes and
`audit` reports 0 findings, or fail loud at the iteration ceiling — ADR-0003).

Two drivers consume that one planner:

- **`heal` — headless driver.** Runs the plan to exhaustion with no prompts,
  collecting Pending decisions and exiting with an `--answers` scaffold
  (ADR-0016). This is **Convergence**.

- **Front door — interactive driver.** Runs the *same* plan with a human
  watching: **one up-front commitment gate** ("I'll fix these N things,
  `[Enter]`"), then **auto-advances to clean** with live progress (#332),
  pausing inline only for genuine **Ambiguities** (ADR-0016). After the first
  `[Enter]`, the user never types another `claude-ds` command and never
  re-runs the door by hand.

The flat single-shot `recommendedNext` recommender is **retired** — it was the
second, divergent brain. The front door becomes a thin interactive loop over
the shared planner.

Consequences for the command taxonomy:

- **Loop members** (the planner sequences these): `upgrade`, `sync`, `repair`,
  `migrate-layout`, `reconcile`, `classify`, `reconform`, `audit --fix`.
- **Entry points** (start a project, not in the loop): `init` (greenfield,
  BLOCK), `adopt` (brownfield, WARN) → hands into the loop.
- **Gated milestone** (the brain *suggests* once clean, never auto-runs):
  `enforce` (WARN → BLOCK, threshold-gated).
- **Surgical / manual** (the user names the target — a real Ambiguity):
  `migrate <path>`.
- **Read-only** (never sequenced; available anytime): `doctor`, `version`,
  `audit` without `--fix`.

The exact slots of `migrate-layout`, `reconcile`, and `reconform` in the order
are verified against `heal`'s implementation before locking, not asserted here.

## Consequences

- **The workflow survives past one keystroke.** `npx …` → gate → `[Enter]` →
  walk to clean. No re-typing, no re-running the door, no falling out of the
  good UI.
- **Upgrade happens first, automatically.** The user never has to know
  ordering — including that convention work is wasted before a pending
  upgrade. The brain owns the order; the human owns the decisions.
- **One source of truth for ordering.** `heal` and the front door cannot
  drift apart or disagree, because they call the same planner. The
  `dashboard.ts` flat order and its self-contradicting comment are deleted.
- **`sync`/`upgrade` overlap stops being a user concern.** Their order- and
  version-sensitivity is absorbed by the loop's re-evaluation; the user never
  reasons about it.
- **Testability is preserved.** The planner is a pure function of project
  state (render separately, snapshot the plan); the interactive driver's
  Ambiguity prompts resolve via `--answers` (ADR-0016) — no pseudo-TTY needed.
- **This is the north star made mechanical.** "Remember as little as
  possible" becomes "press Enter once." A future session that re-introduces a
  hand-typed `→ Next:` breadcrumb chain, or a second ordering brain, is
  overturning this ADR.
