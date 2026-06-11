/**
 * The complaint-ownership registry (PRD #529, issue #533; mechanical
 * enforcement of the completeness principle, ADR-0003).
 *
 * Every finding kind that `status`/`audit` can emit maps here to exactly one
 * **owner**: the canonical-order Operation that fixes it, or a declared
 * **terminal state** — a remedy that lives *outside* the remediation loop
 * (hand-edit, `exceptions.json`, removal, ADR-0026 hand-verify). Nothing a
 * consumer can be told about may fall through to "no owner": that silent drop
 * is exactly the Crewops defect this registry exists to make impossible (the 4
 * advertised hand-rolled DS infra findings that never appeared in the plan —
 * defect 4 — and the hand-verify attribution defect 7 builds on).
 *
 * It bridges the two complaint vocabularies the PRD named:
 *   - the **audit rule-id families** (`DRIFT-` / `INTEGRITY-` / `OWNED-` /
 *     `BYPASS-` / `GEN-`), and
 *   - the planner's **project-state signals**,
 * into one `Owner` codomain — so a finding and a planner signal that share a
 * remedy resolve to the *same* `LoopStep`. `deriveProjectState` folds its
 * findings through `ownerForFinding`, so the front-door planner composes its
 * plan from this registry: a finding whose owner is an Operation lands that
 * step in the plan, and a finding whose owner is terminal is surfaced as a
 * terminal — never silently dropped.
 *
 * The totality of the map is enforced by `complaint-ownership.test.ts`, which
 * enumerates every emitted kind and fails on any that resolves to no owner.
 */

import {
	type DriftRuleId,
	isClassifyRelocatable,
	isExtractionNeededFinding,
	isFixable,
} from "./drift/index.js";
import type { AuditRuleId } from "./exceptions.js";
import {
	type IntegrityRuleId,
	isIntegrityClassifyRelocatable,
	isIntegrityFixable,
} from "./integrity/index.js";
import type { LoopStep, ProjectState } from "./remediation-planner.js";

/**
 * A remedy that lives outside the canonical remediation loop. Each is a real
 * end-of-the-line for a finding kind no `LoopStep` can clear — declared, not
 * implied, so a finding routed here is reported with its reason instead of
 * vanishing.
 */
export type TerminalState =
	/** ADR-0026: a JSX-bearing showcase the regex regenerator can't reproduce.
	 *  `reconform` skips it; the consumer verifies by hand. The state defect 7's
	 *  verify-gate attribution partitions errors against. */
	| "hand-verify"
	/** ADR-0003 / ADR-0017: hand-rolled DS *infrastructure* (an Owned concern).
	 *  The remedy is removal, surfaced by `doctor --completeness` — not a loop
	 *  step that rewrites a file. */
	| "completeness"
	/** ADR-0026: a structural-bypass triage candidate. Advisory only — the
	 *  remedy is "import the atom"; it never blocks or enters the plan. */
	| "advisory"
	/** Unfixable *and* not classify-relocatable (DRIFT-PATTERN-NO-SLOTS,
	 *  DRIFT-ROLE-NO-CONTRACT, INTEGRITY-UNRESOLVABLE-IMPORT, …). The remedy is a
	 *  hand-edit, an `exceptions.json` entry, or waiting for the pack to ship
	 *  machinery — `unresolvableFindings` in the planner. */
	| "manual";

/**
 * Who owns clearing a finding kind: a canonical-order Operation, or a declared
 * terminal state. The shared codomain that lets the audit vocabulary and the
 * planner vocabulary speak about remedies in the same terms.
 */
export type Owner =
	| { kind: "operation"; step: LoopStep }
	| { kind: "terminal"; state: TerminalState; reason: string };

/**
 * Finding kinds carried as rule ids: the audit families plus the
 * generated-integrity ids (`GEN-001`/`GEN-002`) reconform emits, which are
 * status complaints but not `exceptions.json`-dismissable, so they sit outside
 * `AuditRuleId`.
 */
export type GenRuleId = "GEN-001" | "GEN-002";
export type RuleFindingId = AuditRuleId | GenRuleId;

/** The generated-integrity rule ids, for the invariant enumeration. */
export const GEN_RULE_IDS: readonly GenRuleId[] = ["GEN-001", "GEN-002"];

/**
 * The planner vocabulary: each `ProjectState` signal mapped to its owner.
 * Eight of the nine signals own a `LoopStep` (this *is* `planRemediation`'s
 * signal→step wiring, stated as data); `unresolvableFindings` is the planner's
 * own terminal — real findings remain that no loop member can clear.
 */
export const SIGNAL_OWNERS: Record<keyof ProjectState, Owner> = {
	upgradeAvailable: { kind: "operation", step: "upgrade" },
	scaffoldGap: { kind: "operation", step: "sync" },
	repairNeeded: { kind: "operation", step: "repair" },
	layoutMigrationNeeded: { kind: "operation", step: "migrate-layout" },
	reconcileNeeded: { kind: "operation", step: "reconcile" },
	classifyNeeded: { kind: "operation", step: "classify" },
	reconformNeeded: { kind: "operation", step: "reconform" },
	autoFixNeeded: { kind: "operation", step: "audit --fix" },
	unresolvableFindings: {
		kind: "terminal",
		state: "manual",
		reason:
			"unfixable findings remain whose remedy no loop step owns — hand-edit or exceptions.json",
	},
};

/** The `ProjectState` signals, in declaration order, for the invariant enumeration. */
export const PROJECT_STATE_SIGNALS = Object.keys(SIGNAL_OWNERS) as (keyof ProjectState)[];

const TERMINAL_COMPLETENESS: Owner = {
	kind: "terminal",
	state: "completeness",
	reason:
		"hand-rolled DS infrastructure — remove it; surfaced by `claude-ds doctor --completeness` (ADR-0003)",
};

const TERMINAL_ADVISORY: Owner = {
	kind: "terminal",
	state: "advisory",
	reason: "advisory DS-atom bypass — import the atom, or dismiss via exceptions.json (ADR-0026)",
};

const TERMINAL_MANUAL: Owner = {
	kind: "terminal",
	state: "manual",
	reason: "no loop step can clear this — hand-edit or register an exception",
};

/**
 * Resolve the owner of a finding by its rule id alone (kind-level). The
 * registry's spine: a totality-checked mapping from every emitted rule id to
 * an owner, derived from the family prefix plus each family's existing
 * fixability predicates so it cannot drift from the rule shapes it bridges.
 *
 * Instance-level nuance (a DRIFT-RAW-PRIMITIVE finding flagged for extraction
 * routes to `classify`, not `audit --fix`) lives in `ownerForFinding` — the id
 * alone can't see it.
 */
export function ownerForRuleId(id: RuleFindingId): Owner {
	if (id.startsWith("OWNED-")) return TERMINAL_COMPLETENESS;
	if (id.startsWith("BYPASS-")) return TERMINAL_ADVISORY;
	if (id.startsWith("GEN-")) return { kind: "operation", step: "reconform" };
	if (id.startsWith("INTEGRITY-")) {
		const iid = id as IntegrityRuleId;
		if (isIntegrityFixable(iid)) return { kind: "operation", step: "audit --fix" };
		if (isIntegrityClassifyRelocatable(iid)) return { kind: "operation", step: "classify" };
		return TERMINAL_MANUAL;
	}
	const did = id as DriftRuleId;
	if (isFixable(did)) return { kind: "operation", step: "audit --fix" };
	if (isClassifyRelocatable(did)) return { kind: "operation", step: "classify" };
	return TERMINAL_MANUAL;
}

/**
 * Resolve the owner of a concrete finding (instance-level). Layers the one
 * instance-level distinction the kind-level map can't see — an extraction-
 * flagged DRIFT-RAW-PRIMITIVE finding is `classify`'s, not `audit --fix`'s
 * (ADR-0015) — on top of `ownerForRuleId`. This is the entry point
 * `deriveProjectState` folds its drift/integrity findings through.
 */
export function ownerForFinding(finding: { ruleId: string; message: string }): Owner {
	if (isExtractionNeededFinding(finding)) return { kind: "operation", step: "classify" };
	return ownerForRuleId(finding.ruleId as RuleFindingId);
}
