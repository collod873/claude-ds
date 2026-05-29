import { fixMisclassified } from "../relocate.js";
import type { DriftFinding, DriftRule, DriftRuleInput } from "../rule.js";

/** DRIFT-MISCLASSIFIED-ATOM: meta.kind=atom but classifier disagrees. */
function detect(input: DriftRuleInput): DriftFinding | null {
  const { file, metaKind, classifierVerdict } = input;
  if (metaKind !== "atom") return null;
  if (classifierVerdict.tier === "atom") return null;
  if (classifierVerdict.tier === "pattern") return null;
  return {
    ruleId: "DRIFT-MISCLASSIFIED-ATOM",
    file,
    message:
      `declares meta.kind=atom but classifier says ${classifierVerdict.tier}` +
      ` (${classifierVerdict.signals.join("; ")})`,
  };
}

export const misclassifiedAtomRule: DriftRule = {
  id: "DRIFT-MISCLASSIFIED-ATOM",
  severity: "error",
  description: "File declares meta.kind=atom but classifier says otherwise",
  detect,
  fixable: true,
  fix: fixMisclassified,
  priority: 3,
  interactive: false,
};
