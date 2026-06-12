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
 *
 * #620 (PRD #618) rewrote the rendered copy into plain consumer language and
 * gave the renderer the TTY color seam as an injected argument. Internal
 * vocabulary (drift, hand-rolled DS infra, owned-concern scan, scaffold, the
 * pre-adopt/adopted mode names) stays in code and docs but never prints. Status
 * markers are limited to ✓ (good) / ! (action available) / ✗ (problem); these
 * tests inject `identityColor` so they pin the plain copy verbatim.
 */
import { describe, expect, it } from "vitest";
import {
	type ColorAdapter,
	type DashboardState,
	identityColor,
	renderDashboard,
} from "../../../src/lib/render/index.js";

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
	alsoChecked: ["no hand-built design-system scripts", "nothing stale or deprecated"],
};

const INCOMPLETE_WITH_ALSO_CHECKED: DashboardState = {
	cwd: "/repo/example-app",
	mode: "adopted",
	scaffold: { present: 9, total: 12 },
	findings: [],
	upgradeAvailable: true,
	alsoChecked: ["no hand-built design-system scripts", "nothing stale or deprecated"],
};

const HAND_ROLLED_INFRA: DashboardState = {
	cwd: "/repo/example-app",
	mode: "adopted",
	scaffold: { present: 12, total: 12 },
	findings: [],
	handRolledInfra: 2,
	alsoChecked: ["nothing stale or deprecated"],
};

// A marker-tagging adapter: wraps each band so a test can prove the renderer
// routes the glyph (and the path) through the injected color seam, not raw.
const TAG: ColorAdapter = {
	green: (s) => `<g>${s}</g>`,
	red: (s) => `<r>${s}</r>`,
	dim: (s) => `<d>${s}</d>`,
	bold: (s) => `<b>${s}</b>`,
	cyan: (s) => `<c>${s}</c>`,
};

describe("renderDashboard (pure)", () => {
	it("renders the clean adopted state in plain consumer language", () => {
		expect(renderDashboard(CLEAN, identityColor)).toMatchInlineSnapshot(`
      [
        "✓ Design system in place — /repo/example-app",
        "✓ Managed files: 12/12",
        "✓ Everything's up to date — nothing to fix",
      ]
    `);
	});

	it("describes fixable findings as work the tool can do, no internal jargon", () => {
		expect(renderDashboard(WITH_FINDINGS, identityColor)).toMatchInlineSnapshot(`
      [
        "✓ Design system in place — /repo/example-app",
        "✓ Managed files: 12/12",
        "! Needs attention: 3 issues I can fix",
      ]
    `);
	});

	it("an incomplete scaffold with zero findings is NOT 'up to date'", () => {
		// Pinning the dashboard's truth-in-advertising: a 9/12 managed-files line
		// must not co-exist with an "up to date" claim (PR #335 / sub-issue #331).
		expect(renderDashboard(INCOMPLETE_SCAFFOLD, identityColor)).toMatchInlineSnapshot(`
      [
        "✓ Design system in place — /repo/example-app",
        "! Managed files: 9/12 (3 missing)",
        "! Needs attention: 3 missing files",
      ]
    `);
	});

	it("merges missing files with finding count when both fire", () => {
		expect(
			renderDashboard(INCOMPLETE_SCAFFOLD_WITH_FINDINGS, identityColor),
		).toMatchInlineSnapshot(`
      [
        "✓ Design system in place — /repo/example-app",
        "! Managed files: 9/12 (3 missing)",
        "! Needs attention: 3 missing files, 1 issue I can fix",
      ]
    `);
	});

	it("surfaces an available pack update on an otherwise clean tree (#336)", () => {
		expect(renderDashboard(UPGRADE_AVAILABLE, identityColor)).toMatchInlineSnapshot(`
      [
        "✓ Design system in place — /repo/example-app",
        "✓ Managed files: 12/12",
        "! Needs attention: a newer design-system pack is available",
      ]
    `);
	});

	it("renders the not-set-up state (the front door adds the adopt guidance)", () => {
		expect(renderDashboard(PRE_ADOPT, identityColor)).toMatchInlineSnapshot(`
      [
        "! Design system not set up here yet — /repo/fresh-app",
        "! No design-system files installed yet",
      ]
    `);
	});

	it("names the clean read-only scans on an otherwise clean tree (#504)", () => {
		// A check that passes silently reads as a check that never ran. The
		// completeness promise (ADR-0003) is only credible if the tool shows it
		// verified — so a clean owned-concern / deprecated scan is named, not omitted.
		expect(renderDashboard(CLEAN_WITH_ALSO_CHECKED, identityColor)).toMatchInlineSnapshot(`
      [
        "✓ Design system in place — /repo/example-app",
        "✓ Managed files: 12/12",
        "✓ Everything's up to date — nothing to fix",
        "✓ Also checked: no hand-built design-system scripts, nothing stale or deprecated",
      ]
    `);
	});

	it("names clean scans even when other things are wrong (#504)", () => {
		expect(renderDashboard(INCOMPLETE_WITH_ALSO_CHECKED, identityColor)).toMatchInlineSnapshot(`
      [
        "✓ Design system in place — /repo/example-app",
        "! Managed files: 9/12 (3 missing)",
        "! Needs attention: 3 missing files, a newer design-system pack is available",
        "✓ Also checked: no hand-built design-system scripts, nothing stale or deprecated",
      ]
    `);
	});

	it("hand-built scripts are a needs-attention signal, never an 'also checked' one (#504)", () => {
		// The scan that found something is NOT named as clean — it surfaces in the
		// needs-attention roll-up so the tree is never falsely reported clean.
		expect(renderDashboard(HAND_ROLLED_INFRA, identityColor)).toMatchInlineSnapshot(`
      [
        "✓ Design system in place — /repo/example-app",
        "✓ Managed files: 12/12",
        "! Needs attention: 2 scripts you built by hand that the design-system pack now provides",
        "✓ Also checked: nothing stale or deprecated",
      ]
    `);
	});

	it("routes markers and the path through the injected color adapter", () => {
		// On a TTY the printer passes a picocolors-backed adapter; here a tagging
		// adapter proves the glyph (✓ / !) and the cwd reach the seam rather than
		// being emitted raw. Identity → plain (every snapshot above); tagged → wrapped.
		const tagged = renderDashboard(INCOMPLETE_SCAFFOLD, TAG);
		expect(tagged[0]).toBe("<g>✓</g> Design system in place — <d>/repo/example-app</d>");
		expect(tagged[1]).toBe("<c>!</c> Managed files: 9/12 (3 missing)");
		expect(tagged[2]).toBe("<c>!</c> Needs attention: 3 missing files");
	});

	it("contains no internal vocabulary in any rendered line", () => {
		// Acceptance pin: internal terms stay in code/docs, never on the front door.
		const jargon = [
			/\bdrift\b/i,
			/\bhand-rolled\b/i,
			/\bDS infra\b/i,
			/\bowned-concern\b/i,
			/\bscaffold\b/i,
			/\bpre-adopt\b/i,
			/\bfinding\b/i,
			/\breconform\b/i,
		];
		const states = [
			CLEAN,
			WITH_FINDINGS,
			INCOMPLETE_SCAFFOLD,
			INCOMPLETE_SCAFFOLD_WITH_FINDINGS,
			UPGRADE_AVAILABLE,
			PRE_ADOPT,
			CLEAN_WITH_ALSO_CHECKED,
			INCOMPLETE_WITH_ALSO_CHECKED,
			HAND_ROLLED_INFRA,
		];
		for (const state of states) {
			for (const line of renderDashboard(state, identityColor)) {
				for (const term of jargon) {
					expect(line).not.toMatch(term);
				}
			}
		}
	});

	it("uses only the ✓ / ! / ✗ marker vocabulary", () => {
		const allowed = new Set(["✓", "!", "✗"]);
		const states = [CLEAN, WITH_FINDINGS, INCOMPLETE_SCAFFOLD, PRE_ADOPT, HAND_ROLLED_INFRA];
		for (const state of states) {
			for (const line of renderDashboard(state, identityColor)) {
				const marker = line.charAt(0);
				expect(allowed.has(marker)).toBe(true);
			}
		}
	});

	it("is pure — calling twice returns equal arrays", () => {
		expect(renderDashboard(WITH_FINDINGS, identityColor)).toEqual(
			renderDashboard(WITH_FINDINGS, identityColor),
		);
	});
});
