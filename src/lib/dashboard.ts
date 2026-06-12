/**
 * The dashboard brain (PRD #325 sub-issue #331). Pure: it folds doctor
 * structural state + a read-only audit's findings into the renderable
 * `DashboardState` — the "where you are / what's wrong" summary the front door
 * prints above its commitment gate.
 *
 * The flat single-shot `recommendNextStep` recommender that used to live here
 * was retired in #345 (ADR-0018): it was a second ordering brain that diverged
 * from `heal`'s loop (it ranked `upgrade` last instead of first) and computed
 * "next step" counts independently of what the command would actually do (F11).
 * The front door now drives the shared `planRemediation` planner directly, so
 * there is exactly one ordering brain and the gate preview is the real planned
 * `Change[]`, never a recommended string.
 *
 * The brain lives separately from the renderer so non-TTY callers can request
 * the same shape (a future `--json` dashboard surface) without dragging in the
 * orchestration code.
 */

import type { HandRolledSplit } from "./hand-rolled-split.js";
import type { DashboardFinding, DashboardState } from "./render/dashboard.js";

export interface DashboardInput {
	cwd: string;
	/** `"pre-adopt"` when no `.claude-ds.json` exists; `"adopted"` otherwise. */
	mode: "pre-adopt" | "adopted";
	/** Pack name — used to format the pre-adopt `adopt --pack <name>` recommendation. */
	pack: string;
	/** From `scanScaffoldPresence` — present/total managed+seeded files. */
	scaffold: { present: number; total: number };
	/** Missing managed files in adopted mode (lookalikes are reported separately by doctor). */
	missingManaged: number;
	/** Root-level dupes of canonical design-system/ files (#23). */
	rootDupes: number;
	/** Drift + integrity findings from a read-only `scanDriftAndIntegrity` pass. */
	findings: ReadonlyArray<{ ruleId: string; file: string; message: string }>;
	/** Subset of `findings` that need extraction (classify, not audit --fix). */
	extractionCount: number;
	/** Subset of `findings` that audit cannot auto-repair (report-only relocates,
	 *  unresolvable imports, deferred extraction). */
	unfixableCount: number;
	/** Detected build command — what the clean-tree recommendation invokes. */
	buildCmd: string;
	/** Pinned `packVersion` is older than the installed CLI (#336). Pre-adopt
	 *  callers and up-to-date projects pass `false`; the brain only surfaces
	 *  the signal in adopted mode. Defaults to `false` so callers not yet
	 *  wired to version currency keep today's behavior. */
	upgradeAvailable?: boolean;
	/** The retirable / needs-review split of hand-rolled DS infra findings from
	 *  the read-only owned-concern scan (ADR-0003 / #504 / #639). Surfaced as a
	 *  "what's wrong" signal, phrased apart by supersession. */
	handRolled?: HandRolledSplit;
	/** Labels of the read-only completeness scans that ran clean (#504). */
	alsoChecked?: string[];
}

export function composeDashboardState(input: DashboardInput): DashboardState {
	const findings: DashboardFinding[] = input.findings.map((f) => ({
		ruleId: f.ruleId,
		file: f.file,
		message: f.message,
	}));
	return {
		cwd: input.cwd,
		mode: input.mode,
		scaffold: input.scaffold,
		findings,
		upgradeAvailable: input.mode === "adopted" && input.upgradeAvailable === true,
		handRolled: input.mode === "adopted" ? input.handRolled : undefined,
		alsoChecked: input.mode === "adopted" ? input.alsoChecked : undefined,
	};
}
