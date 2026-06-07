# v1.2.0 friction probe — unexercised commands

Filed: 2026-06-07 (issue #352, parent PRD #340).

The original v1.2.0 friction report (which produced PRD #340) was explicitly
partial — `enforce`, `migrate`, `migrate-layout`, `reconform`, and `version`
were never exercised in a real adopted project, and live-TTY feel (color,
prompt timing, interrupt behavior) was blind. This pass closes that gap.

## Method

Stood up a fresh next-react-shaped scratch project (`tsconfig` with `@/*` and
`@ds/*` aliases, a single `app/page.tsx`, a single `src/components/lonely.tsx`
smart atom), `git init`-ed it, ran `claude-ds adopt --yes`, then drove each
unexercised command through its main paths and a few edge cases. The CLI
under test was the locally-built `claude-ds@1.2.0` (`dist/cli.js`).

For each command, the probe checked: happy path, failure paths, no-op /
idempotency, dirty-tree behavior, non-TTY behavior, and whether the final
output matches the `→ Next:` breadcrumb convention CONTEXT.md mandates.

## Surfaced friction

16 findings, filed as separate issues:

### Critical
- **#355** — `migrate-layout` silently renames `.tsx` files to `.json`
  canonical paths (lookalike detector matches by stem only, ignoring extension;
  consumer content is destroyed in-place, auto-committed by the same command).

### Wrong-recommendation / contradicts ADRs
- **#356** — `version --check` tells the consumer to run `reconcile` when
  behind a version; the correct command per ADR-0011 addendum is `upgrade`.
- **#359** — `migrate-layout` auto-commits the renames and emits
  "re-run adopt to proceed" even when invoked post-adopt.

### Silent feature gaps
- **#357** — `version --check` never prints CHANGELOG sections; `pkgRoot` is
  off-by-one (resolves to `dist/`, not the package root).
- **#358** — `reconform` silently drops a real PRIN-000 violation because the
  check-script exits 1 (script's chosen code) while `runCheckScripts` treats
  exit 1 as "self-error, skip"; reconform then verdicts "no violations".

### Convention violations
- **#361** — All five probed commands lack the `→ Next:` breadcrumb
  CONTEXT.md mandates on completion.
- **#365** — `reconform --backfill-meta` / `--demote-composites` silently
  no-op without `--fix` instead of refusing at argument-parse.
- **#370** — Five commands emit plain `console.log` — no color, no progress
  affordance (the front door has the TTY adapter; these don't reach for it).

### Usability / output quality
- **#360** — `migrate` exits 1 with a raw Node `ENOENT` stack for missing
  source paths.
- **#362** — `migrate` registers a `DRIFT-MISPLACED` exception for a
  *correctly-placed* file and has no `--issue` flag for the link the CLI
  itself nudges you to add.
- **#363** — `enforce` lies "mode flipped" on idempotent re-runs; gate
  refusal has no recovery hint; permanent exceptions count toward the gate
  threshold against CONTEXT.md's "informational" framing.
- **#364** — `confirm()` on non-TTY (closed stdin) silently aborts with
  exit 0; ADR-0016 calls for fail-loud on non-TTY ambiguity.
- **#366** — `reconform`'s stub-file warning fires every run with no
  acknowledge path or recipe for what "populating contracts.md" entails.
- **#367** — `version`'s "installed" label means CLI version in `--check`
  and pinned version in default mode — same word, two meanings.
- **#368** — `version`'s `latest: unknown` silently absorbs all
  `git ls-remote` failures; hardcoded `collod873/claude-ds` remote means
  forks see "unknown" forever.
- **#369** — `migrate`'s auto-generated showcase stub returns `null` with
  no comment, no `→ Next:`, no docs reference.

## Across-the-set patterns

- The `→ Next:` breadcrumb convention is **uniformly absent** outside the
  front-door / adopt / audit flows. Filed once (#361) but evident in every
  finding above.
- "Silent" failure modes are the dominant theme: silent file-type mismatch
  rename (#355), silent CHANGELOG miss (#357), silent violation drop (#358),
  silent flag no-op (#365), silent TTY-absent abort (#364), silent fork
  remote (#368). Each is small individually; together they form the same
  surface-area-of-trust problem PRD #340 set out to fix in the front door.
- `version`, `migrate`, and `migrate-layout` each contradict at least one
  ADR-0011 / ADR-0016 statement.

The PRD predicted "expect the count to rise" — it has. The findings here
should be folded into the PRD #340 work or treated as parallel cleanup,
depending on the ADR-0018 spine's scope.
