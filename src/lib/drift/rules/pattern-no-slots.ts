import { hasSlotExports } from "../../classifier.js";

import type { DriftFinding, DriftRule, DriftRuleInput } from "../rule.js";

/** DRIFT-PATTERN-NO-SLOTS: file under patterns/ does not export children or named slot props. */
function detect(input: DriftRuleInput): DriftFinding | null {
	const { file, locationTier, source } = input;
	if (locationTier !== "pattern") return null;
	if (source === undefined) return null;
	if (hasSlotExports(source)) return null;
	return {
		ruleId: "DRIFT-PATTERN-NO-SLOTS",
		file,
		message: "file under design-system/patterns/ does not export children or named slot props",
	};
}

export const patternNoSlotsRule: DriftRule = {
	id: "DRIFT-PATTERN-NO-SLOTS",
	severity: "error",
	description: "Pattern-tier file does not export children or named slot props",
	detect,
	fixable: false,
	// Adding slot exports is a hand-authoring decision about the pattern's
	// shape; no loop step rewrites the file. Consumer hand-edit or
	// exceptions.json entry, not classify.
	classifyRelocatable: false,
};
