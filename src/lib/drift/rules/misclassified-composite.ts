import { fixMisclassified } from "../relocate.js";
import type { DriftFinding, DriftRule, DriftRuleInput } from "../rule.js";

/** DRIFT-MISCLASSIFIED-COMPOSITE: meta.kind=composite but classifier disagrees. */
function detect(input: DriftRuleInput): DriftFinding | null {
  const { file, metaKind, classifierVerdict } = input;
  if (metaKind !== "composite") return null;
  if (classifierVerdict.tier === "composite") return null;
  if (classifierVerdict.tier === "pattern") return null;
  return {
    ruleId: "DRIFT-MISCLASSIFIED-COMPOSITE",
    file,
    message:
      `declares meta.kind=composite but classifier says ${classifierVerdict.tier}` +
      ` (${classifierVerdict.signals.join("; ")})`,
  };
}

export const misclassifiedCompositeRule: DriftRule = {
  id: "DRIFT-MISCLASSIFIED-COMPOSITE",
  severity: "error",
  description: "File declares meta.kind=composite but classifier says otherwise",
  detect,
  fixable: true,
  fix: fixMisclassified,
  priority: 3,
  interactive: false,
};
