import type { DriftFinding, DriftRule, DriftRuleInput } from "../rule.js";

/** DRIFT-PATTERN-IMPORTS-PATTERN: pattern-tier file imports from another pattern. */
function detect(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, classifierVerdict } = input;
  if (locationTier !== "pattern") return null;
  if (!classifierVerdict.signals.some(s => s.includes("design-system/patterns/"))) return null;
  return {
    ruleId: "DRIFT-PATTERN-IMPORTS-PATTERN",
    file,
    message: "pattern-tier file imports from design-system/patterns/ — patterns must not nest other patterns",
  };
}

export const patternImportsPatternRule: DriftRule = {
  id: "DRIFT-PATTERN-IMPORTS-PATTERN",
  severity: "error",
  description: "Pattern-tier file imports from another pattern, violating the no-nested-patterns rule",
  detect,
  fixable: false,
  // Breaking the cycle is a refactoring call (extract the shared shell,
  // demote one pattern, switch composition style); no loop step makes that
  // decision. Consumer hand-edit or exceptions.json.
  classifyRelocatable: false,
};
