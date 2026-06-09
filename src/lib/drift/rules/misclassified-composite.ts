import type { DriftFinding, DriftRule, DriftRuleInput } from "../rule.js";

/**
 * DRIFT-MISCLASSIFIED-COMPOSITE: meta.kind=composite but classifier disagrees.
 *
 * Report-only per ADR-0015: `audit` never moves files or flips meta.kind
 * structurally. Fixing the disagreement is a placement decision owned by
 * `classify`, which moves the file (rewriting importers) or flips meta.kind
 * in one pass. Mirrors the prior-art shape from #198.
 */
function detect(input: DriftRuleInput): DriftFinding | null {
	const { file, metaKind, classifierVerdict } = input;
	if (metaKind !== "composite") return null;
	if (classifierVerdict.tier === "composite") return null;
	if (classifierVerdict.tier === "pattern") return null;
	// One classification boundary (PRD #241 / #244): symmetric with
	// DRIFT-MISCLASSIFIED-ATOM. An ambiguous verdict cannot contradict
	// meta.kind=composite.
	if (classifierVerdict.ambiguous) return null;
	return {
		ruleId: "DRIFT-MISCLASSIFIED-COMPOSITE",
		file,
		message:
			`declares meta.kind=composite but classifier says ${classifierVerdict.tier}` +
			` (${classifierVerdict.signals.join("; ")})` +
			` — run \`claude-ds classify\` to relocate or update meta.kind`,
	};
}

export const misclassifiedCompositeRule: DriftRule = {
	id: "DRIFT-MISCLASSIFIED-COMPOSITE",
	severity: "error",
	description: "File declares meta.kind=composite but classifier says otherwise",
	detect,
	fixable: false,
	// Symmetric with DRIFT-MISCLASSIFIED-ATOM — classify owns the remedy.
	classifyRelocatable: true,
};
