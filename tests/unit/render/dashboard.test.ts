/**
 * PRD #325 sub-issue #330 — `renderDashboard` is a pure function: it returns
 * a line array from a `DashboardState`, performs no I/O, and reads no global
 * state. Snapshot tests guard the human-facing surface so a later slice
 * cannot regress it unnoticed.
 *
 * The state shape is the seam the front-door slice will fill in (`doctor` +
 * read-only `audit` composed into one struct); this slice just pins the
 * pure-function contract and the representative-fixture outputs.
 */
import { describe, it, expect } from "vitest";
import {
  renderDashboard,
  type DashboardState,
} from "../../../src/lib/render/index.js";

const CLEAN: DashboardState = {
  cwd: "/repo/example-app",
  mode: "adopted",
  scaffold: { present: 12, total: 12 },
  findings: [],
  recommendedNext: null,
};

const WITH_FINDINGS: DashboardState = {
  cwd: "/repo/example-app",
  mode: "adopted",
  scaffold: { present: 12, total: 12 },
  findings: [
    {
      ruleId: "DRIFT-RAW-PRIMITIVE",
      file: "design-system/atoms/button.tsx",
      message: "color #336699 has no token equivalent",
    },
    {
      ruleId: "DRIFT-RAW-PRIMITIVE",
      file: "design-system/atoms/card.tsx",
      message: "color #ffffff has no token equivalent",
    },
    {
      ruleId: "INTEGRITY-UNRESOLVED-SYMBOL",
      file: "design-system/atoms/badge.tsx",
      message: "TS2304: Cannot find name 'cn'",
    },
  ],
  recommendedNext: {
    command: "claude-ds audit --fix",
    description: "auto-repair the 3 findings",
  },
};

const PRE_ADOPT: DashboardState = {
  cwd: "/repo/fresh-app",
  mode: "pre-adopt",
  findings: [],
  recommendedNext: {
    command: "claude-ds adopt",
    description: "install the design-system scaffold",
  },
};

describe("renderDashboard (pure)", () => {
  it("renders the clean adopted state", () => {
    expect(renderDashboard(CLEAN)).toMatchInlineSnapshot(`
      [
        "Where you are: adopted (/repo/example-app)",
        "Scaffold: 12/12 ✓",
        "What's wrong: nothing — tree is clean",
      ]
    `);
  });

  it("renders the with-findings adopted state with a recommended next step", () => {
    expect(renderDashboard(WITH_FINDINGS)).toMatchInlineSnapshot(`
      [
        "Where you are: adopted (/repo/example-app)",
        "Scaffold: 12/12 ✓",
        "What's wrong: 3 findings",
        "→ Next: claude-ds audit --fix — auto-repair the 3 findings",
      ]
    `);
  });

  it("renders the pre-adopt state with the adopt next step", () => {
    expect(renderDashboard(PRE_ADOPT)).toMatchInlineSnapshot(`
      [
        "Where you are: pre-adopt (/repo/fresh-app)",
        "What's wrong: no scaffold installed yet",
        "→ Next: claude-ds adopt — install the design-system scaffold",
      ]
    `);
  });

  it("is pure — calling twice returns equal arrays", () => {
    expect(renderDashboard(WITH_FINDINGS)).toEqual(renderDashboard(WITH_FINDINGS));
  });
});
