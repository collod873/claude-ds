/**
 * The shared remediation planner (issue #342, ADR-0018).
 *
 * The single source of truth for *what to run next, in what order* to drive a
 * not-clean project toward clean. Two drivers consume it: `heal` (headless —
 * runs to a fixed point, collects Pending decisions, exits with `--answers`
 * scaffold), and the front door (interactive — one up-front commitment gate,
 * then auto-advance with live progress, pausing only for Ambiguities).
 *
 * The canonical order is fixed by ADR-0018. The flat single-shot
 * `recommendedNext` recommender in `dashboard.ts` ranked `upgrade`
 * second-to-last (rank 6 of 7) while its own comment claimed to "mirror the
 * ADR-0003 heal-loop ordering" — the v1.2.0 friction symptom #3 the planner
 * exists to mechanically prevent. Convention work (`classify`, `audit --fix`)
 * run before a pending upgrade is wasted: the migrations are about to rewrite
 * the very tree that work operated on.
 *
 * This module is the pure brain. No I/O, no prompts, no driver concerns. The
 * driver wiring (`heal` thin headless wrapper, front door thin interactive
 * wrapper) lands in subsequent sub-issues of PRD #340.
 */

export type LoopStep =
	| "upgrade"
	| "sync"
	| "repair"
	| "migrate-layout"
	| "reconcile"
	| "classify"
	| "reconform"
	| "audit --fix";

/**
 * ADR-0018 canonical order. Exported so the tests can pin the order without
 * re-stating it and so both drivers refer to the same constant rather than
 * duplicating the literal. A re-order is a deliberate ADR amendment, not a
 * code-level refactor.
 */
export const CANONICAL_ORDER: readonly LoopStep[] = [
	"upgrade",
	"sync",
	"repair",
	"migrate-layout",
	"reconcile",
	"classify",
	"reconform",
	"audit --fix",
];

/**
 * The structural signals the planner reads. One boolean per loop member —
 * "does this step have work to do?" — folded by the drivers from their
 * existing read-only scans (doctor structural state + a read-only audit pass
 * + version-currency check). Booleans, not counts: the planner sequences
 * *whether* to run, not *how much*; the driver surfaces counts in the gate UI.
 */
export interface ProjectState {
	/** Pinned `packVersion` is older than the installed CLI. ADR-0011 addendum
	 *  (#341): "upgrade available" fires only when a newer version actually
	 *  exists. */
	upgradeAvailable: boolean;
	/** A managed file is missing or its bytes drifted from the manifest. ADR-
	 *  0018 names this a "scaffold gap," reserving "drift" for the `DRIFT-`
	 *  audit family. Healed by `sync`. */
	scaffoldGap: boolean;
	/** End-state of one or more applied migrations has regressed at the current
	 *  `packVersion` (flipped flag, deleted managed file). ADR-0011 addendum
	 *  (#341): surfaced as "repair needed: N settings regressed," never as
	 *  "upgrade." */
	repairNeeded: boolean;
	/** Pre-current pack layout detected — files in legacy locations the current
	 *  manifest no longer recognizes. */
	layoutMigrationNeeded: boolean;
	/** Root-level dupes of canonical files, deprecated paths from prior pack
	 *  versions, or dangling hooks. */
	reconcileNeeded: boolean;
	/** Inline components need extraction, or other findings audit cannot
	 *  auto-repair that classify owns. */
	classifyNeeded: boolean;
	/** Companion files / meta / claude-md migration / role-proposer work
	 *  reconform owns. */
	reconformNeeded: boolean;
	/** Auto-fixable drift or integrity findings remain. */
	autoFixNeeded: boolean;
	/**
	 * Unfixable findings remain whose remedy no canonical-order step owns
	 * (DRIFT-PATTERN-NO-SLOTS, DRIFT-PATTERN-IMPORTS-PATTERN,
	 * DRIFT-ROLE-NO-CONTRACT, INTEGRITY-UNRESOLVABLE-IMPORT — anything with
	 * `fixable: false` and `classifyRelocatable: false`). Does NOT drive a
	 * step in the plan — there is no loop member that can resolve them —
	 * but the headless driver reads this signal so heal does not silently
	 * declare convergence with real ERROR findings outstanding (#379). The
	 * remedies live outside the loop: hand-edit, `exceptions.json`, or
	 * waiting for the pack to ship machinery.
	 */
	unresolvableFindings: boolean;
}

/**
 * Compute the ordered remediation plan from project state.
 *
 * Pure: no I/O, no prompts, no mutation of the input. Returns the subset of
 * `CANONICAL_ORDER` whose signals fire, preserving the canonical order. A
 * clean state returns `[]`.
 *
 * The driver consumes the plan as the sequence of sub-commands to dispatch
 * this iteration. After each dispatch the driver re-scans state and re-plans;
 * convergence is reached when `planRemediation(state)` returns `[]` and the
 * iteration produced zero on-disk changes (ADR-0003 fixed-point guarantee).
 */
export function planRemediation(state: ProjectState): LoopStep[] {
	const plan: LoopStep[] = [];
	if (state.upgradeAvailable) plan.push("upgrade");
	if (state.scaffoldGap) plan.push("sync");
	if (state.repairNeeded) plan.push("repair");
	if (state.layoutMigrationNeeded) plan.push("migrate-layout");
	if (state.reconcileNeeded) plan.push("reconcile");
	if (state.classifyNeeded) plan.push("classify");
	if (state.reconformNeeded) plan.push("reconform");
	if (state.autoFixNeeded) plan.push("audit --fix");
	return plan;
}
