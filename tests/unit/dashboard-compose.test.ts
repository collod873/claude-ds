/**
 * PRD #325 sub-issue #331 — `composeDashboardState` is the pure brain that
 * folds doctor structural state + read-only audit findings into the
 * `DashboardState` the renderer prints. The brain lives separately from the
 * renderer so non-TTY callers can request the same shape (e.g. a future
 * `--json` dashboard surface), and so the state-→-recommendation logic stays
 * out of the orchestration code.
 *
 * These tests pin the composition behavior across the fixture states the PRD
 * names (clean, drifty, missing scaffold). The recommendation cases match
 * `printNextStep`'s breadcrumb engine — the dashboard is the breadcrumb
 * promoted from "after a command" to "the front door."
 */
import { describe, it, expect } from "vitest";
import { composeDashboardState, type DashboardInput } from "../../src/lib/dashboard.js";

function baseAdopted(): DashboardInput {
  return {
    cwd: "/repo/example-app",
    mode: "adopted",
    pack: "next-react",
    scaffold: { present: 12, total: 12 },
    missingManaged: 0,
    rootDupes: 0,
    findings: [],
    extractionCount: 0,
    unfixableCount: 0,
    buildCmd: "npm run build",
  };
}

describe("composeDashboardState (pure brain)", () => {
  it("pre-adopt → recommends adopt for the configured pack", () => {
    const state = composeDashboardState({
      cwd: "/repo/fresh-app",
      mode: "pre-adopt",
      pack: "next-react",
      scaffold: { present: 0, total: 12 },
      missingManaged: 0,
      rootDupes: 0,
      findings: [],
      extractionCount: 0,
      unfixableCount: 0,
      buildCmd: "npm run build",
    });

    expect(state.mode).toBe("pre-adopt");
    expect(state.findings).toEqual([]);
    expect(state.recommendedNext).toEqual({
      command: "claude-ds adopt --pack next-react",
      description: "install the design-system scaffold",
    });
  });

  it("adopted clean tree → recommends running the detected build command", () => {
    const state = composeDashboardState(baseAdopted());

    expect(state.mode).toBe("adopted");
    expect(state.findings).toEqual([]);
    expect(state.recommendedNext).toEqual({
      command: "npm run build",
      description: "verify everything compiles",
    });
  });

  it("adopted with auto-fixable findings → recommends audit --fix", () => {
    const state = composeDashboardState({
      ...baseAdopted(),
      findings: [
        { ruleId: "DRIFT-RAW-PRIMITIVE", file: "design-system/atoms/button.tsx", message: "color #336699 has no token equivalent" },
        { ruleId: "DRIFT-RAW-PRIMITIVE", file: "design-system/atoms/card.tsx", message: "color #ffffff has no token equivalent" },
      ],
      extractionCount: 0,
      unfixableCount: 0,
    });

    expect(state.recommendedNext).toEqual({
      command: "claude-ds audit --fix",
      description: "auto-repair the 2 findings",
    });
  });

  it("singularizes the auto-repair recommendation for one finding", () => {
    const state = composeDashboardState({
      ...baseAdopted(),
      findings: [{ ruleId: "DRIFT-RAW-PRIMITIVE", file: "a.tsx", message: "x" }],
    });

    expect(state.recommendedNext).toEqual({
      command: "claude-ds audit --fix",
      description: "auto-repair the 1 finding",
    });
  });

  it("adopted with extraction-needed findings → recommends classify with count", () => {
    const state = composeDashboardState({
      ...baseAdopted(),
      findings: [
        { ruleId: "DRIFT-RAW-PRIMITIVE", file: "design-system/composites/cal.tsx", message: "inline component DayCell needs extraction" },
        { ruleId: "DRIFT-RAW-PRIMITIVE", file: "design-system/composites/cal.tsx", message: "inline component MonthCell needs extraction" },
      ],
      extractionCount: 2,
      unfixableCount: 2,
    });

    expect(state.recommendedNext).toEqual({
      command: "claude-ds classify",
      description: "extract 2 inline components",
    });
  });

  it("singularizes the extraction recommendation for one component", () => {
    const state = composeDashboardState({
      ...baseAdopted(),
      findings: [
        { ruleId: "DRIFT-RAW-PRIMITIVE", file: "x.tsx", message: "x" },
      ],
      extractionCount: 1,
      unfixableCount: 1,
    });

    expect(state.recommendedNext?.description).toBe("extract 1 inline component");
  });

  it("adopted with unfixable (non-extraction) findings → recommends classify", () => {
    const state = composeDashboardState({
      ...baseAdopted(),
      findings: [
        { ruleId: "DRIFT-MISPLACED", file: "design-system/atoms/sidebar.tsx", message: "composite-shaped under atoms/" },
      ],
      extractionCount: 0,
      unfixableCount: 1,
    });

    expect(state.recommendedNext).toEqual({
      command: "claude-ds classify",
      description: "address findings audit can't auto-repair",
    });
  });

  it("missing managed files outrank audit findings — recommend sync first", () => {
    const state = composeDashboardState({
      ...baseAdopted(),
      missingManaged: 3,
      findings: [{ ruleId: "DRIFT-RAW-PRIMITIVE", file: "a.tsx", message: "x" }],
    });

    expect(state.recommendedNext).toEqual({
      command: "claude-ds sync",
      description: "restore 3 missing managed file(s)",
    });
  });

  it("root dupes outrank audit findings — recommend reconcile", () => {
    const state = composeDashboardState({
      ...baseAdopted(),
      rootDupes: 2,
      findings: [{ ruleId: "DRIFT-RAW-PRIMITIVE", file: "a.tsx", message: "x" }],
    });

    expect(state.recommendedNext).toEqual({
      command: "claude-ds reconcile",
      description: "resolve 2 root-level duplicate(s)",
    });
  });

  it("adopted + stale packVersion (clean tree) → recommends upgrade", () => {
    // PRD #336: version currency is the third brain input alongside doctor
    // structural state and audit findings. A clean tree pinned to an older
    // pack version no longer falls straight through to "verify everything
    // compiles" — the dashboard surfaces the upgrade nudge first.
    const state = composeDashboardState({
      ...baseAdopted(),
      upgradeAvailable: true,
    });

    expect(state.upgradeAvailable).toBe(true);
    expect(state.recommendedNext).toEqual({
      command: "claude-ds upgrade",
      description: "pack version is behind the installed CLI",
    });
  });

  it("upgrade-available outranks the clean-tree build recommendation only", () => {
    // Structural and audit findings still win — you do not upgrade onto a
    // broken baseline. With auto-fixable findings present the brain stays on
    // `audit --fix` even though the pack is stale.
    const state = composeDashboardState({
      ...baseAdopted(),
      upgradeAvailable: true,
      findings: [{ ruleId: "DRIFT-RAW-PRIMITIVE", file: "a.tsx", message: "x" }],
    });

    expect(state.upgradeAvailable).toBe(true);
    expect(state.recommendedNext).toEqual({
      command: "claude-ds audit --fix",
      description: "auto-repair the 1 finding",
    });
  });

  it("missing managed files still outrank upgrade-available", () => {
    const state = composeDashboardState({
      ...baseAdopted(),
      missingManaged: 2,
      upgradeAvailable: true,
    });

    expect(state.recommendedNext).toEqual({
      command: "claude-ds sync",
      description: "restore 2 missing managed file(s)",
    });
  });

  it("up-to-date adopted clean tree exposes no upgrade signal", () => {
    // The absence of the input (or upgradeAvailable=false) means today's
    // clean-tree behavior is preserved exactly.
    const state = composeDashboardState({
      ...baseAdopted(),
      upgradeAvailable: false,
    });

    expect(state.upgradeAvailable).toBe(false);
    expect(state.recommendedNext).toEqual({
      command: "npm run build",
      description: "verify everything compiles",
    });
  });

  it("pre-adopt projects are unaffected by upgradeAvailable", () => {
    // Pre-adopt has no .claude-ds.json, so no pinned packVersion exists to
    // compare. The brain must still recommend adopt regardless.
    const state = composeDashboardState({
      cwd: "/repo/fresh-app",
      mode: "pre-adopt",
      pack: "next-react",
      scaffold: { present: 0, total: 12 },
      missingManaged: 0,
      rootDupes: 0,
      findings: [],
      extractionCount: 0,
      unfixableCount: 0,
      buildCmd: "npm run build",
      upgradeAvailable: true,
    });

    expect(state.recommendedNext).toEqual({
      command: "claude-ds adopt --pack next-react",
      description: "install the design-system scaffold",
    });
  });

  it("the rendered → Next line matches the recommendation fields", () => {
    // Pins the contract the integration test relies on: the brain picks the
    // command, and the renderer surfaces it on a `→ Next:` line. Together they
    // mean "the dashboard's recommendation is the same string `printNextStep`
    // would print for the same state" without us calling printNextStep here.
    const input: DashboardInput = {
      ...baseAdopted(),
      findings: [
        { ruleId: "DRIFT-RAW-PRIMITIVE", file: "a.tsx", message: "x" },
        { ruleId: "DRIFT-RAW-PRIMITIVE", file: "b.tsx", message: "y" },
      ],
    };
    const state = composeDashboardState(input);
    expect(state.recommendedNext).not.toBeNull();
    expect(state.recommendedNext!.command).toBe("claude-ds audit --fix");
  });
});
