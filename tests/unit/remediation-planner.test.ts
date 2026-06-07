/**
 * Issue #342 / ADR-0018 — the shared remediation planner.
 *
 * The planner is the single source of truth for *what to run next, in what
 * order* to drive a not-clean project toward clean. Two drivers consume it:
 *   - `heal` (headless): runs the plan to a fixed point, collects Pending
 *     decisions, exits with an `--answers` scaffold.
 *   - The front door (interactive): runs the same plan with live progress,
 *     pausing inline only for genuine Ambiguities.
 *
 * The canonical order is fixed by ADR-0018:
 *   upgrade → sync → repair → migrate-layout → reconcile → classify →
 *   reconform → audit --fix
 *
 * These tests pin:
 *   1. The planner is pure — given the same `ProjectState` it always returns
 *      the same plan, in the same order, with no side effects.
 *   2. Representative states (behind-version, scaffold-gap, dirty, clean,
 *      mixed) produce the right ordered subset of loop members.
 *   3. A regression test that `upgrade` precedes the convention work
 *      (`classify` / `audit --fix`) — the v1.2.0 friction symptom #3 the
 *      planner exists to mechanically prevent (dashboard.ts:118).
 */
import { describe, it, expect } from "vitest";
import {
  planRemediation,
  type ProjectState,
  type LoopStep,
  CANONICAL_ORDER,
} from "../../src/lib/remediation-planner.js";

function cleanState(): ProjectState {
  return {
    upgradeAvailable: false,
    scaffoldGap: false,
    repairNeeded: false,
    layoutMigrationNeeded: false,
    reconcileNeeded: false,
    classifyNeeded: false,
    reconformNeeded: false,
    autoFixNeeded: false,
    unresolvableFindings: false,
  };
}

describe("planRemediation — canonical order", () => {
  it("exports the ADR-0018 canonical order", () => {
    // The CANONICAL_ORDER constant is the single source of truth both drivers
    // import. Pinning it here means a re-order during a future refactor
    // surfaces as a deliberate test edit, not a silent drift.
    expect(CANONICAL_ORDER).toEqual([
      "upgrade",
      "sync",
      "repair",
      "migrate-layout",
      "reconcile",
      "classify",
      "reconform",
      "audit --fix",
    ]);
  });

  it("every-signal state returns every loop member in canonical order", () => {
    const allSet: ProjectState = {
      upgradeAvailable: true,
      scaffoldGap: true,
      repairNeeded: true,
      layoutMigrationNeeded: true,
      reconcileNeeded: true,
      classifyNeeded: true,
      reconformNeeded: true,
      autoFixNeeded: true,
      unresolvableFindings: true,
    };
    expect(planRemediation(allSet)).toEqual([
      "upgrade",
      "sync",
      "repair",
      "migrate-layout",
      "reconcile",
      "classify",
      "reconform",
      "audit --fix",
    ]);
  });
});

describe("planRemediation — representative states", () => {
  it("clean state → empty plan", () => {
    expect(planRemediation(cleanState())).toEqual([]);
  });

  it("behind-version (stale packVersion, otherwise clean) → [upgrade]", () => {
    expect(
      planRemediation({ ...cleanState(), upgradeAvailable: true }),
    ).toEqual(["upgrade"]);
  });

  it("scaffold-gap (managed file missing) → [sync]", () => {
    expect(planRemediation({ ...cleanState(), scaffoldGap: true })).toEqual([
      "sync",
    ]);
  });

  it("dirty (auto-fixable findings only) → [audit --fix]", () => {
    expect(planRemediation({ ...cleanState(), autoFixNeeded: true })).toEqual([
      "audit --fix",
    ]);
  });

  it("unresolvableFindings does NOT add a loop step (#379)", () => {
    // The post-#379 deriver routes unfixable findings whose remedy no loop
    // step owns (PATTERN-IMPORTS-PATTERN, ROLE-NO-CONTRACT, …) into
    // `unresolvableFindings` rather than misleading `classifyNeeded`. The
    // planner must NOT emit a step for it — there is no canonical-order
    // member that resolves these. The driver consumes the signal directly
    // for its convergence gate; the planner stays unchanged so it can't
    // recommend a step that will spin without progress.
    expect(
      planRemediation({ ...cleanState(), unresolvableFindings: true }),
    ).toEqual([]);
  });

  it("mixed (behind-version + scaffold-gap + classify + audit) → ordered subset", () => {
    expect(
      planRemediation({
        ...cleanState(),
        upgradeAvailable: true,
        scaffoldGap: true,
        classifyNeeded: true,
        autoFixNeeded: true,
      }),
    ).toEqual(["upgrade", "sync", "classify", "audit --fix"]);
  });
});

describe("planRemediation — ordering regression", () => {
  it("upgrade precedes classify when both fire", () => {
    // Pins the v1.2.0 friction symptom #3 (dashboard.ts:118): the flat
    // single-shot recommender ranked upgrade *below* classify, so a stale
    // tree with extraction-needed findings was told to extract first onto a
    // tree migrations were about to rewrite. The planner mechanically
    // prevents that ordering from ever returning.
    const plan = planRemediation({
      ...cleanState(),
      upgradeAvailable: true,
      classifyNeeded: true,
    });
    expect(plan.indexOf("upgrade")).toBeLessThan(plan.indexOf("classify"));
  });

  it("upgrade precedes audit --fix when both fire", () => {
    const plan = planRemediation({
      ...cleanState(),
      upgradeAvailable: true,
      autoFixNeeded: true,
    });
    expect(plan.indexOf("upgrade")).toBeLessThan(plan.indexOf("audit --fix"));
  });

  it("every adjacent pair in any returned plan respects CANONICAL_ORDER", () => {
    // Generalised guard: regardless of which signals fire, the returned plan
    // is always a sub-sequence of CANONICAL_ORDER. A future signal added in
    // the wrong slot fails this without needing a bespoke pair-wise test.
    const everyCombo: ProjectState[] = [];
    const keys: Array<keyof ProjectState> = [
      "upgradeAvailable",
      "scaffoldGap",
      "repairNeeded",
      "layoutMigrationNeeded",
      "reconcileNeeded",
      "classifyNeeded",
      "reconformNeeded",
      "autoFixNeeded",
      "unresolvableFindings",
    ];
    for (let mask = 0; mask < 1 << keys.length; mask++) {
      const s = cleanState();
      keys.forEach((k, i) => {
        if (mask & (1 << i)) s[k] = true;
      });
      everyCombo.push(s);
    }
    for (const state of everyCombo) {
      const plan = planRemediation(state);
      const indices = plan.map((step) =>
        CANONICAL_ORDER.indexOf(step as LoopStep),
      );
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i]).toBeGreaterThan(indices[i - 1]);
      }
    }
  });
});

describe("planRemediation — purity", () => {
  it("does not mutate its input", () => {
    const state: ProjectState = {
      upgradeAvailable: true,
      scaffoldGap: true,
      repairNeeded: false,
      layoutMigrationNeeded: false,
      reconcileNeeded: false,
      classifyNeeded: true,
      reconformNeeded: false,
      autoFixNeeded: true,
      unresolvableFindings: false,
    };
    const snapshot = { ...state };
    planRemediation(state);
    expect(state).toEqual(snapshot);
  });

  it("repeated calls with the same input return equal plans", () => {
    const state: ProjectState = {
      ...cleanState(),
      upgradeAvailable: true,
      reconcileNeeded: true,
      autoFixNeeded: true,
    };
    const first = planRemediation(state);
    const second = planRemediation(state);
    expect(first).toEqual(second);
    // Distinct array instances — the function returns a fresh array each
    // call, not a shared reference a caller could mutate to poison the next
    // run.
    expect(first).not.toBe(second);
  });
});
