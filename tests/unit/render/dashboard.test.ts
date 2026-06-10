/**
 * PRD #325 sub-issue #330 — `renderDashboard` is a pure function: it returns
 * a line array from a `DashboardState`, performs no I/O, and reads no global
 * state. Snapshot tests guard the human-facing surface so a later slice
 * cannot regress it unnoticed.
 *
 * #345 (ADR-0018) retired the third "→ Next" section: the flat `recommendedNext`
 * recommender was a second ordering brain. The dashboard is now two sections —
 * "where you are / what's wrong" — and the front door drives the shared planner
 * for "what to do next" (one commitment gate, not a recommended string).
 */
import { describe, expect, it } from "vitest";
import { type DashboardState, renderDashboard } from "../../../src/lib/render/index.js";

const CLEAN: DashboardState = {
	cwd: "/repo/example-app",
	mode: "adopted",
	scaffold: { present: 12, total: 12 },
	findings: [],
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
};

const INCOMPLETE_SCAFFOLD: DashboardState = {
	cwd: "/repo/example-app",
	mode: "adopted",
	scaffold: { present: 9, total: 12 },
	findings: [],
};

const INCOMPLETE_SCAFFOLD_WITH_FINDINGS: DashboardState = {
	cwd: "/repo/example-app",
	mode: "adopted",
	scaffold: { present: 9, total: 12 },
	findings: [
		{
			ruleId: "DRIFT-RAW-PRIMITIVE",
			file: "design-system/atoms/button.tsx",
			message: "color #336699 has no token equivalent",
		},
	],
};

const UPGRADE_AVAILABLE: DashboardState = {
	cwd: "/repo/example-app",
	mode: "adopted",
	scaffold: { present: 12, total: 12 },
	findings: [],
	upgradeAvailable: true,
};

const PRE_ADOPT: DashboardState = {
	cwd: "/repo/fresh-app",
	mode: "pre-adopt",
	findings: [],
};

const CLEAN_WITH_ALSO_CHECKED: DashboardState = {
	cwd: "/repo/example-app",
	mode: "adopted",
	scaffold: { present: 12, total: 12 },
	findings: [],
	alsoChecked: ["no hand-rolled DS infra", "nothing stale or deprecated"],
};

const INCOMPLETE_WITH_ALSO_CHECKED: DashboardState = {
	cwd: "/repo/example-app",
	mode: "adopted",
	scaffold: { present: 9, total: 12 },
	findings: [],
	upgradeAvailable: true,
	alsoChecked: ["no hand-rolled DS infra", "nothing stale or deprecated"],
};

const HAND_ROLLED_INFRA: DashboardState = {
	cwd: "/repo/example-app",
	mode: "adopted",
	scaffold: { present: 12, total: 12 },
	findings: [],
	handRolledInfra: 2,
	alsoChecked: ["nothing stale or deprecated"],
};

describe("renderDashboard (pure)", () => {
	it("renders the clean adopted state", () => {
		expect(renderDashboard(CLEAN)).toMatchInlineSnapshot(`
      [
        "Where you are: adopted (/repo/example-app)",
        "Managed files: 12/12 ✓",
        "What's wrong: nothing — tree is clean",
      ]
    `);
	});

	it("renders the with-findings adopted state (no recommended-next line)", () => {
		expect(renderDashboard(WITH_FINDINGS)).toMatchInlineSnapshot(`
      [
        "Where you are: adopted (/repo/example-app)",
        "Managed files: 12/12 ✓",
        "What's wrong: 3 findings",
      ]
    `);
	});

	it("an incomplete scaffold with zero findings is NOT 'tree is clean'", () => {
		// Pinning the dashboard's truth-in-advertising: a `Scaffold: 9/12` line
		// must not co-exist with "tree is clean" (PR #335 / sub-issue #331).
		expect(renderDashboard(INCOMPLETE_SCAFFOLD)).toMatchInlineSnapshot(`
      [
        "Where you are: adopted (/repo/example-app)",
        "Managed files: 9/12",
        "What's wrong: scaffold incomplete",
      ]
    `);
	});

	it("merges scaffold incomplete with finding count when both fire", () => {
		expect(renderDashboard(INCOMPLETE_SCAFFOLD_WITH_FINDINGS)).toMatchInlineSnapshot(`
      [
        "Where you are: adopted (/repo/example-app)",
        "Managed files: 9/12",
        "What's wrong: scaffold incomplete + 1 finding",
      ]
    `);
	});

	it("surfaces upgrade-available on an otherwise clean tree (#336)", () => {
		expect(renderDashboard(UPGRADE_AVAILABLE)).toMatchInlineSnapshot(`
      [
        "Where you are: adopted (/repo/example-app)",
        "Managed files: 12/12 ✓",
        "What's wrong: upgrade available",
      ]
    `);
	});

	it("renders the pre-adopt state (the front door adds the adopt guidance)", () => {
		expect(renderDashboard(PRE_ADOPT)).toMatchInlineSnapshot(`
      [
        "Where you are: pre-adopt (/repo/fresh-app)",
        "What's wrong: no scaffold installed yet",
      ]
    `);
	});

	it("names the clean read-only scans on an otherwise clean tree (#504)", () => {
		// A check that passes silently reads as a check that never ran. The
		// completeness promise (ADR-0003) is only credible if the tool shows it
		// verified — so a clean owned-concern / deprecated scan is named, not omitted.
		expect(renderDashboard(CLEAN_WITH_ALSO_CHECKED)).toMatchInlineSnapshot(`
      [
        "Where you are: adopted (/repo/example-app)",
        "Managed files: 12/12 ✓",
        "What's wrong: nothing — tree is clean",
        "Also checked: no hand-rolled DS infra, nothing stale or deprecated ✓",
      ]
    `);
	});

	it("names clean scans even when other things are wrong (#504)", () => {
		expect(renderDashboard(INCOMPLETE_WITH_ALSO_CHECKED)).toMatchInlineSnapshot(`
      [
        "Where you are: adopted (/repo/example-app)",
        "Managed files: 9/12",
        "What's wrong: scaffold incomplete + upgrade available",
        "Also checked: no hand-rolled DS infra, nothing stale or deprecated ✓",
      ]
    `);
	});

	it("hand-rolled DS infra is a what's-wrong signal, never an 'also checked' one (#504)", () => {
		// The scan that found something is NOT named as clean — it surfaces in
		// "What's wrong" so the tree is never falsely reported clean.
		expect(renderDashboard(HAND_ROLLED_INFRA)).toMatchInlineSnapshot(`
      [
        "Where you are: adopted (/repo/example-app)",
        "Managed files: 12/12 ✓",
        "What's wrong: 2 hand-rolled DS infra findings",
        "Also checked: nothing stale or deprecated ✓",
      ]
    `);
	});

	it("is pure — calling twice returns equal arrays", () => {
		expect(renderDashboard(WITH_FINDINGS)).toEqual(renderDashboard(WITH_FINDINGS));
	});
});
