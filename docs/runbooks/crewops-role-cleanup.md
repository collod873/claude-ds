# Crewops cleanup — role contracts (PRD #301, sub-issue #314)

Runbook for the dogfood-consumer cleanup that closes PRD #301. Runs in
Crewops, not claude-ds — every pack-side artifact this depends on already
shipped in sub-issues #308–#313 on this branch. The work below is the TTY
pass Collin executes against Crewops once the PRD merges.

## What this run proves

The four PRD #301 acceptance criteria for #314:

1. The 88 empty `.test.tsx` stubs and the deferred `combobox.test.tsx`
   structural guard are removed from Crewops.
2. The Crewops combobox declares `meta.role: "combobox"` and the shipped
   role contract runs green against it.
3. Reintroducing the split-context defect makes the contract fail
   (the bug-catcher is real, not a change-detector).
4. `role_contracts_strict: true` is set in Crewops with a tracked record
   of the removal trigger for the future flag-flip Migration Op.

Criterion 3 is **already mechanically proven** in the pack — independent of
any consumer state — by:

- `packs/next-react/tests/contracts/combobox.test.ts` — the combobox
  contract PASSES `mountComboboxGood` and FAILS `mountComboboxBroken` (the
  split-context fixture).
- `packs/next-react/tests/contracts/runner.test.ts` — end-to-end through
  `runRoleContracts`, a broken combobox declaring `role: "combobox"` rejects
  with `/BrokenCombobox.*combobox.*split-context|commit/i`.

That pair is the recorded demonstration. The Crewops run below confirms the
same contract runs green against Crewops's *fixed* combobox (criterion 2)
and that the broken fixture's failure shape matches what Crewops's
historical bug looked like (criterion 3, second half).

## Pre-flight

```sh
cd ~/"Claude Projects/claude-ds"
git checkout main && npm run build && npm link    # `claude-ds` on PATH points at this code

cd ~/"Claude Projects/Crewops"
git status                                        # must be clean before starting
```

## Step 1 — Remove the 88 empty stubs + `combobox.test.tsx`

`testStub` mint retired in #313, so reconform no longer regrows these.
Direct `git rm` is the explicit decision (PRD #301 "Out of Scope": no
`retire-test-stubs` Migration Op while there is one consumer).

```sh
# Enumerate every per-component .test.tsx under design-system/.
git ls-files 'design-system/atoms/*.test.tsx' \
            'design-system/composites/*.test.tsx' \
            'design-system/patterns/*.test.tsx' \
  | tee /tmp/crewops-test-tsx.txt
wc -l /tmp/crewops-test-tsx.txt    # expect 89 (88 empty + combobox.test.tsx)

# git rm them all — empty stubs and the deferring combobox guard alike.
xargs git rm < /tmp/crewops-test-tsx.txt

git status --short | head -20
```

Expected after: `git diff --cached --name-status | grep -c '^D'` reports
**89** deletions, every one under `design-system/{atoms,composites,patterns}/`
ending in `.test.tsx`. No new files staged.

## Step 2 — Declare `meta.role: "combobox"` on the Crewops combobox

```sh
# classify proposes the role for smart parts whose markup matches a shipped
# contract's ARIA anchor (sub-issue #312 / src/lib/role-proposer.ts).
claude-ds sync
claude-ds classify
```

`classify` walks `design-system/{atoms,composites}/`, finds the combobox by
its `role="combobox"` markup, and injects `role: "combobox"` into its
`meta` export. Verify:

```sh
grep -n 'role: *"combobox"' design-system/{atoms,composites}/*.tsx
```

Expected: one match on the combobox source file. If `classify` proposed
"candidate feature" instead, the combobox markup is not ARIA-correct —
fix the markup, re-run `classify`, do not hand-edit the role in.

## Step 3 — Confirm the role contract runs green against the Crewops combobox

The role-contract runner ships at
`design-system/contracts/role-contracts.test.tsx` (sub-issue #310) and runs
in the vitest + jsdom runtime already seeded by #297.

```sh
npx vitest run design-system/contracts/role-contracts.test.tsx
```

Expected: **1 test passes** — `combobox (role: combobox)`. The vitest UI
lists one test case per role-bearing component; pre-cleanup Crewops has
exactly one (the combobox).

If the contract fails here, the combobox has a real behavioral defect —
that is the system working as designed. Fix the component; do not exempt
the test.

## Step 4 — Prove the catch by reintroducing the split-context defect

Mechanical proof of criterion 3 already lives in pack tests (see top of
file). To demonstrate the same catch on the real Crewops component,
transiently break it and re-run the contract:

```sh
# Open design-system/{atoms,composites}/combobox.tsx and replace the
# option-click handler with one that updates an internal variable but
# never propagates the selection to the trigger — mirrors
# packs/next-react/files/design-system/_fixtures/combobox-broken.ts.

npx vitest run design-system/contracts/role-contracts.test.tsx
```

Expected: the contract rejects with a message containing
`split-context` / `commit` / `reflect` / `value`, naming the Crewops
combobox file and example. Revert the transient edit:

```sh
git checkout -- design-system/{atoms,composites}/combobox.tsx
npx vitest run design-system/contracts/role-contracts.test.tsx
```

Expected: green again. Paste the failing diagnostic into the
`#314` issue thread as the recorded catch (PRD criterion 3, "demonstrated").

## Step 5 — Set `role_contracts_strict: true` with a tracked removal trigger

```sh
# .claude-ds.json — flip the flag.
node -e '
  const fs = require("node:fs");
  const c = JSON.parse(fs.readFileSync(".claude-ds.json", "utf8"));
  c.role_contracts_strict = true;
  fs.writeFileSync(".claude-ds.json", JSON.stringify(c, null, 2) + "\n");
'

claude-ds audit    # must exit 0 — every smart part now carries a role
                   # (classify backfilled in Step 2). If a smart part is
                   # left roleless, that's a real DRIFT-SMART-PART-NO-ROLE
                   # to triage per ADR-0016 (presentational / exceptions /
                   # features) — not a reason to leave the flag off.
```

JSON has no comments, and the config parser rejects unknown fields
(`src/lib/config.ts:35-39`), so the tracked removal-trigger record lives
in **both** of these (so it can't rot in just one):

1. **The PR body** that flips the flag — a line of the form:

   > `role_contracts_strict: true` is an explicit Crewops-side override.
   > Remove this commit's flag flip when the upstream `role-contracts-hard`
   > Migration Op ships (claude-ds PRD #301, builds when consumer #2 exists).
   > Tracked: claude-ds #314.

2. A line in Crewops's `design-system/exceptions.json` `_notes` field — the
   "tracked workarounds with removal triggers" pattern from ADR-0003.
   Adopted shape (no schema change needed — `exceptions.json` is a hybrid
   file the consumer owns):

   ```jsonc
   {
     "exceptions": [],
     "_notes": [
       {
         "kind": "config-override",
         "field": "role_contracts_strict",
         "value": true,
         "reason": "Explicit until upstream role-contracts-hard Op flips the default.",
         "removal_trigger": "claude-ds PRD #301 ships the role-contracts-hard Migration Op (built when consumer #2 exists).",
         "issue": "claude-ds#314"
       }
     ]
   }
   ```

   `_notes` is not parsed by claude-ds — it survives `sync` because
   `exceptions.json` is hybrid-owned; consumer-supplied keys are preserved.

## Convergence check

```sh
claude-ds heal                                            # → exit 0
npx vitest run design-system/contracts/role-contracts.test.tsx    # → exit 0
git diff --cached --name-status | wc -l                   # net deletions: 89 .test.tsx; net adds: meta.role line, .claude-ds.json flag, _notes entry
```

Then commit; one squash PR per Crewops convention.

## Out of scope (recorded for the avoidance of doubt)

- **Building the `role-contracts-hard` Migration Op.** PRD #301: "build
  that Op only when consumer #2 exists." Single-consumer flag flips
  manually.
- **Adding more role contracts.** ADR-0016: every additional contract is
  a separately-justified issue tied to a real component. The combobox
  ships; nothing else.
- **A separate a11y verification subsystem.** Subsumed by role contracts
  (they drive via ARIA — a component must be ARIA-correct to be drivable
  at all).
