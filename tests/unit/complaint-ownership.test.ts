/**
 * Complaint-ownership invariant (PRD #529, issue #533).
 *
 * The completeness principle (ADR-0003) made mechanical: every finding kind
 * `status`/`audit` can emit must map to an owner — a canonical-order Operation
 * that fixes it, or a declared terminal state. A finding with no owner is the
 * Crewops defect-4 failure mode (advertised findings that silently vanish from
 * the plan). This test enumerates every emitted kind across *both* complaint
 * vocabularies — the audit rule-id families and the planner's project-state
 * signals — and fails on any that resolves to no owner.
 *
 * It asserts external structure only: that the registry is total over the
 * emitted vocabulary and that every operation-owner names a real loop step.
 */

import { describe, expect, it } from "vitest";
import {
	GEN_RULE_IDS,
	type Owner,
	ownerForRuleId,
	PROJECT_STATE_SIGNALS,
	type RuleFindingId,
	SIGNAL_OWNERS,
} from "../../src/lib/complaint-ownership.js";
import { allRuleIds } from "../../src/lib/drift/index.js";
import { allIntegrityRuleIds } from "../../src/lib/integrity/index.js";
import { allOwnedConcernIds } from "../../src/lib/owned-concerns/index.js";
import { CANONICAL_ORDER } from "../../src/lib/remediation-planner.js";
import { allStructuralBypassIds } from "../../src/lib/structural-bypass/index.js";

const LOOP_STEPS = new Set<string>(CANONICAL_ORDER);

/** Every finding kind carried as a rule id, across all emitting families. */
function allRuleFindingIds(): RuleFindingId[] {
	return [
		...allRuleIds(),
		...allIntegrityRuleIds(),
		...allOwnedConcernIds(),
		...allStructuralBypassIds(),
		...GEN_RULE_IDS,
	];
}

/** An owner is well-formed if its operation names a real loop step, or its
 *  terminal state carries a non-empty reason. */
function isWellFormed(owner: Owner): boolean {
	if (owner.kind === "operation") return LOOP_STEPS.has(owner.step);
	return owner.reason.trim().length > 0;
}

describe("complaint-ownership registry", () => {
	it("maps every emitted rule-id finding kind to a well-formed owner", () => {
		const unowned: string[] = [];
		for (const id of allRuleFindingIds()) {
			const owner = ownerForRuleId(id);
			if (!isWellFormed(owner)) unowned.push(id);
		}
		expect(unowned).toEqual([]);
	});

	it("maps every planner project-state signal to a well-formed owner", () => {
		const unowned: string[] = [];
		for (const signal of PROJECT_STATE_SIGNALS) {
			if (!isWellFormed(SIGNAL_OWNERS[signal])) unowned.push(signal);
		}
		expect(unowned).toEqual([]);
	});

	it("never resolves a finding kind to undefined (totality)", () => {
		for (const id of allRuleFindingIds()) {
			expect(ownerForRuleId(id)).toBeDefined();
		}
	});

	// Defect 4 regression: the 4 advertised hand-rolled DS infra findings that
	// never appeared in the plan or any step's output. Hand-rolled infra is an
	// Owned-concern finding (`OWNED-`); it is advertised by the dashboard's
	// `handRolledInfra` count but is NOT a remediation-loop member. Before the
	// registry, that gap was un-enforced — the finding could be advertised and
	// then silently dropped. Now every Owned concern must resolve to a terminal
	// state with a stated reason (`completeness`), so it is reported, not lost.
	it("every advertised hand-rolled DS infra (Owned concern) finding declares a terminal remedy with a reason — defect 4", () => {
		const ownedIds = allOwnedConcernIds();
		expect(ownedIds.length).toBeGreaterThan(0);
		for (const id of ownedIds) {
			const owner = ownerForRuleId(id);
			expect(owner.kind).toBe("terminal");
			if (owner.kind === "terminal") {
				expect(owner.state).toBe("completeness");
				expect(owner.reason.trim().length).toBeGreaterThan(0);
			}
		}
	});

	// Front-door status numbers are consistent with the composed plan: every
	// rule-id whose owner is an Operation names a step the planner can actually
	// run, so an advertised finding routed to a step cannot reference a phantom
	// command the loop never dispatches.
	it("every operation-owner names a step in the canonical remediation order", () => {
		for (const id of allRuleFindingIds()) {
			const owner = ownerForRuleId(id);
			if (owner.kind === "operation") {
				expect(LOOP_STEPS.has(owner.step)).toBe(true);
			}
		}
		for (const signal of PROJECT_STATE_SIGNALS) {
			const owner = SIGNAL_OWNERS[signal];
			if (owner.kind === "operation") {
				expect(LOOP_STEPS.has(owner.step)).toBe(true);
			}
		}
	});
});
