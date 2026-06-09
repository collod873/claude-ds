import { hasShippedContract } from "../role-contracts.js";

import type { DriftFinding, DriftRule, DriftRuleInput } from "../rule.js";

/**
 * DRIFT-ROLE-NO-CONTRACT (ADR-0016, PRD #301 / #311).
 *
 * Informational rule. Fires on a DS atom/composite that declares a
 * `meta.role` for which the pack ships no contract — the surface that points
 * the consumer at the tracked-exception path: register the gap in
 * `exceptions.json` with an upstream issue whose removal trigger is "the
 * contract ships." Stays informational by design: a role declaration with no
 * shipped contract is a documented gap, not a defect (the defect would be
 * silently ungoverned smart parts, which `DRIFT-SMART-PART-NO-ROLE` covers).
 *
 * The shipped-roles list lives in `src/lib/drift/role-contracts.ts` —
 * synchronised with the pack's `Role` union so the CLI can decide without
 * importing the pack's TypeScript at scan time. Today only `combobox` ships;
 * ADR-0016's anti-speculative-infra rule means the list grows one entry per
 * landed contract, never speculatively.
 *
 * Not gated by `roleContractsStrict`: this is informational, and a consumer
 * who opted in to declaring a role wants to know whether the contract exists
 * regardless of the strict-flag rollout.
 */
function detect(input: DriftRuleInput): DriftFinding | null {
	const { file, locationTier, metaRole } = input;
	if (locationTier !== "atom" && locationTier !== "composite") return null;
	if (!metaRole) return null;
	if (hasShippedContract(metaRole)) return null;
	return {
		ruleId: "DRIFT-ROLE-NO-CONTRACT",
		file,
		message: `meta.role "${metaRole}" has no shipped contract — register the gap in exceptions.json with a tracked upstream issue (removal trigger: the contract ships)`,
	};
}

export const roleNoContractRule: DriftRule = {
	id: "DRIFT-ROLE-NO-CONTRACT",
	severity: "info",
	description:
		"DS file declares a meta.role for which the pack ships no contract; document via exceptions.json",
	detect,
	fixable: false,
	// The remedy is upstream (pack ships the contract) or downstream
	// (consumer registers a tracked exception); no loop step touches the
	// consumer's file to resolve it.
	classifyRelocatable: false,
};
