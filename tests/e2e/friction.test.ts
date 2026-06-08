/**
 * Friction gate e2e (PRD #439) — the closing edge of the verification loop.
 *
 * Runs the **real built CLI** through the real command sequence — the post-adopt
 * journey (`adopt → heal → audit --fix → doctor → classify → sync → reconcile →
 * upgrade → version → enforce → reconform → front door`) plus alternate-tree
 * captures (`greet` pre-adopt, greenfield `init`, git-seeded `migrate-layout`)
 * and an interactive PTY front-door capture — against copies of the harvested
 * `crewops-snapshot` fixture, captures the rendered stdout/stderr, runs the
 * pure friction detector over it (with a real next-step runner injected), and
 * reconciles the findings against the committed `friction-baseline.json`.
 *
 * The ratchet (user story 14): a finding NOT in the baseline is a regression
 * and FAILS this test. Baseline keys may only be removed across commits — the
 * gate never writes the baseline. A baseline entry that no longer reproduces is
 * surfaced (`stale`) so a fix can burn it down, but does not fail the gate.
 *
 * On day one this gate is GREEN despite known friction: the baseline records
 * the accepted starting set, so the test passes as long as nothing NEW appears.
 * Burning down the baseline is the work of the separate friction-fix issues
 * (PRD #439 "Out of Scope") — this test is the gate, not the repair.
 *
 * Wired into the blocking smoke tier (#415) via `.github/workflows/e2e-smoke.yml`
 * and `npm run e2e:friction`, so it runs on every PR — not nightly — and a CI
 * friction failure reproduces locally without pushing.
 *
 * Auto-skips when `dist/cli.js` is absent so the suite stays green for devs who
 * haven't built; CI builds first.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runFrictionGate, readBaseline, keysMissingTriggers } from "./friction-gate.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const DIST_CLI = resolve(REPO_ROOT, "dist", "cli.js");
const FIXTURE = resolve(REPO_ROOT, "tests", "e2e", "fixtures", "crewops-snapshot");
const BASELINE = resolve(REPO_ROOT, "tests", "e2e", "friction-baseline.json");
const GOLDEN_DIR = resolve(REPO_ROOT, "tests", "e2e", "golden");

const hasDist = existsSync(DIST_CLI);

// The ADR-0003 trigger invariant (#456): every accepted finding must document
// how it burns down. Runs WITHOUT dist — it's a pure check on the committed
// baseline file — so a missing trigger fails plain `vitest`, not just CI's
// built e2e tier. Closes the gap where the baseline's own _comment claimed this
// was enforced when no code checked it.
describe("friction baseline integrity (#456)", () => {
  it("every baseline key carries a non-empty removal trigger", async () => {
    const baseline = await readBaseline(BASELINE);
    const orphans = keysMissingTriggers(baseline);
    expect(
      orphans,
      `Baseline keys with no _removal_triggers entry (ADR-0003 requires one per key):\n` +
        orphans.map((k) => `  ${k}`).join("\n"),
    ).toEqual([]);
  });
});

describe.skipIf(!hasDist)("e2e friction gate: crewops-snapshot", () => {
  it("findings reconcile with the committed baseline (no regressions)", async () => {
    const baseline = await readBaseline(BASELINE);

    const result = await runFrictionGate(
      {
        fixtureDir: FIXTURE,
        cliPath: DIST_CLI,
        goldenDir: GOLDEN_DIR,
        timeoutMs: 90_000,
      },
      baseline,
    );

    // The ratchet: any finding not in the baseline is a regression. The failure
    // message lists the offending keys so the operator either fixes the new
    // friction or — if it is genuinely accepted — adds it through review (which
    // the runbook discourages: the baseline only shrinks).
    expect(
      result.regressions,
      `New friction NOT in tests/e2e/friction-baseline.json (regressions ⇒ fail):\n` +
        result.regressions.map((f) => `  [${f.kind}] ${f.key}\n    ${f.message}`).join("\n"),
    ).toHaveLength(0);

    // Human-readable bottom line for the CI run page.
    // eslint-disable-next-line no-console
    console.log(
      `[e2e-friction] pass=${result.pass} findings=${result.findings.length} ` +
        `baseline=${baseline.keys.length} stale=${result.stale.length}` +
        (result.stale.length
          ? `\n[e2e-friction] STALE baseline entries (finding gone — safe to remove): ${result.stale.join(", ")}`
          : ""),
    );
  }, 180_000);
});
