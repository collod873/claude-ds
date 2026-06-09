import type { DriftFinding, DriftRule, DriftRuleInput } from "../rule.js";

/**
 * DRIFT-MISPLACED: file's folder tier ≠ classifier verdict.
 *
 * Report-only per ADR-0015: `audit` is surgical and never moves files. The
 * remediation is `claude-ds classify`, which owns every tier move and rewrites
 * importers as part of the move so it can never leave a dangling `@ds/*`
 * import. Mirrors the prior-art shape from #198 (DRIFT-RAW-PRIMITIVE's
 * extraction-needed defer): same rule id, same severity, just no fixer.
 *
 * Pattern verdict is suppressed — pattern classification requires explicit
 * declaration (meta.kind or directory placement). Use `classify` for discovery.
 */
function detect(input: DriftRuleInput): DriftFinding | null {
	const { file, locationTier, classifierVerdict } = input;
	if (locationTier === null) return null;
	if (locationTier === classifierVerdict.tier) return null;
	if (classifierVerdict.tier === "pattern") return null;
	// One classification boundary (PRD #241 / #244): defer to the consumer's
	// current placement when the atom/composite call is ambiguous (1-2 DS
	// imports). Classify's ambiguity prompt fires only at the confident
	// composite threshold; audit must match.
	if (classifierVerdict.ambiguous) return null;
	return {
		ruleId: "DRIFT-MISPLACED",
		file,
		message:
			`located in ${locationTier}s/ but classifier says ${classifierVerdict.tier}` +
			` (${classifierVerdict.signals.join("; ")})` +
			` — run \`claude-ds classify\` to relocate it`,
	};
}

export const misplacedRule: DriftRule = {
	id: "DRIFT-MISPLACED",
	severity: "error",
	description: "File lives in a folder that disagrees with its classifier-computed tier",
	detect,
	fixable: false,
	// `classify` literally exists to fix this — it's the canonical example.
	classifyRelocatable: true,
};
