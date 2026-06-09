/**
 * The dashboard renderer (PRD #325 sub-issue #330). Pure: it takes a
 * resolved `DashboardState` and returns a `string[]`. The front door fills the
 * state in (composing `doctor` structural state + a read-only `audit` run);
 * this module pins the renderer contract and the representative-fixture outputs.
 *
 * The shape is now two sections — "where you are / what's wrong". The third,
 * "recommended next step", was the flat single-shot `recommendedNext`
 * recommender, retired in #345 (ADR-0018): the front door no longer hands the
 * user a `→ Next: <type this>` breadcrumb. It drives the shared remediation
 * planner directly, presenting one commitment gate (rendered from the real
 * planned `Change[]`) and auto-advancing to clean. "What to do next" is the
 * gate, not a recommended string.
 */

export type DashboardMode = "pre-adopt" | "adopted" | "fresh";

export interface DashboardFinding {
	ruleId: string;
	file: string;
	message: string;
}

export interface DashboardState {
	cwd: string;
	mode: DashboardMode;
	scaffold?: { present: number; total: number };
	findings: DashboardFinding[];
	/** Pinned `packVersion` is older than the installed CLI (#336). Renderer
	 *  folds this into the "What's wrong" line so a stale-but-healthy project
	 *  still surfaces a signal that explains why the gate will run `upgrade`.
	 *  Optional so callers not yet wired to version currency keep today's
	 *  behavior. */
	upgradeAvailable?: boolean;
}

export function renderDashboard(state: DashboardState): string[] {
	const lines: string[] = [];

	lines.push(`Where you are: ${state.mode} (${state.cwd})`);

	if (state.scaffold) {
		const { present, total } = state.scaffold;
		const tick = present === total ? " ✓" : "";
		lines.push(`Managed files: ${present}/${total}${tick}`);
	}

	const scaffoldIncomplete =
		state.scaffold !== undefined && state.scaffold.present !== state.scaffold.total;
	const findingsCount = state.findings.length;
	const upgradeAvailable = state.upgradeAvailable === true;

	if (state.mode === "pre-adopt") {
		lines.push("What's wrong: no scaffold installed yet");
	} else if (!scaffoldIncomplete && findingsCount === 0 && !upgradeAvailable) {
		lines.push("What's wrong: nothing — tree is clean");
	} else {
		// An incomplete scaffold, audit findings, and a stale pack version are
		// all "what's wrong" signals. Surfacing only some of them would let a
		// `Scaffold: 0/12` line co-exist with a "tree is clean" claim, which is
		// what the renderer must not say. The upgrade-available chunk explains
		// why the brain picked `claude-ds upgrade` on a structurally clean tree
		// (#336).
		const parts: string[] = [];
		if (scaffoldIncomplete) parts.push("scaffold incomplete");
		if (findingsCount > 0) {
			const noun = findingsCount === 1 ? "finding" : "findings";
			parts.push(`${findingsCount} ${noun}`);
		}
		if (upgradeAvailable) parts.push("upgrade available");
		lines.push(`What's wrong: ${parts.join(" + ")}`);
	}

	return lines;
}
