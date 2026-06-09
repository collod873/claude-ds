/**
 * PRD #325 sub-issue #331 — `composeDashboardState` is the pure brain that
 * folds doctor structural state + read-only audit findings into the
 * `DashboardState` the renderer prints ("where you are / what's wrong").
 *
 * #345 (ADR-0018) retired the `recommendedNext` recommender that used to live
 * here — it was a second ordering brain, divergent from `heal`'s loop, that
 * computed "next step" counts independently of what the command did (F11). The
 * front door now drives the shared `planRemediation` planner directly. What
 * remains in the brain is the findings projection and the `upgradeAvailable`
 * gate (adopted-only), which these tests pin.
 */
import { describe, expect, it } from "vitest";
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
	it("carries mode and scaffold through unchanged", () => {
		const state = composeDashboardState(baseAdopted());
		expect(state.mode).toBe("adopted");
		expect(state.scaffold).toEqual({ present: 12, total: 12 });
	});

	it("projects findings into the renderable shape (ruleId / file / message)", () => {
		const state = composeDashboardState({
			...baseAdopted(),
			findings: [
				{
					ruleId: "DRIFT-RAW-PRIMITIVE",
					file: "design-system/atoms/button.tsx",
					message: "color #336699 has no token equivalent",
				},
				{
					ruleId: "INTEGRITY-UNRESOLVED-SYMBOL",
					file: "design-system/atoms/badge.tsx",
					message: "TS2304: Cannot find name 'cn'",
				},
			],
		});
		expect(state.findings).toEqual([
			{
				ruleId: "DRIFT-RAW-PRIMITIVE",
				file: "design-system/atoms/button.tsx",
				message: "color #336699 has no token equivalent",
			},
			{
				ruleId: "INTEGRITY-UNRESOLVED-SYMBOL",
				file: "design-system/atoms/badge.tsx",
				message: "TS2304: Cannot find name 'cn'",
			},
		]);
	});

	it("the brain no longer emits a recommendedNext (recommender retired #345)", () => {
		const state = composeDashboardState({
			...baseAdopted(),
			findings: [{ ruleId: "DRIFT-RAW-PRIMITIVE", file: "a.tsx", message: "x" }],
		});
		expect("recommendedNext" in state).toBe(false);
	});

	it("surfaces upgradeAvailable on an adopted tree", () => {
		const state = composeDashboardState({ ...baseAdopted(), upgradeAvailable: true });
		expect(state.upgradeAvailable).toBe(true);
	});

	it("upgradeAvailable defaults to false when the input omits it", () => {
		const state = composeDashboardState(baseAdopted());
		expect(state.upgradeAvailable).toBe(false);
	});

	it("gates upgradeAvailable to adopted mode — pre-adopt never surfaces it", () => {
		// Pre-adopt has no pinned packVersion to compare; the signal is meaningless
		// there and the front door routes to adopt regardless.
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
		expect(state.mode).toBe("pre-adopt");
		expect(state.upgradeAvailable).toBe(false);
	});
});
