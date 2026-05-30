import type { DriftFinding, DriftRule, DriftRuleInput } from "../rule.js";

/**
 * DRIFT-MISCLASSIFIED-ATOM: meta.kind=atom but classifier disagrees.
 *
 * Report-only per ADR-0015: `audit` never moves files or flips meta.kind
 * structurally. Fixing the disagreement is a placement decision owned by
 * `classify`, which moves the file (rewriting importers) or flips meta.kind
 * in one pass. Mirrors the prior-art shape from #198.
 */
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
      ` (${classifierVerdict.signals.join("; ")})` +
      ` — run \`claude-ds classify\` to relocate or update meta.kind`,
  };
}

export const misclassifiedAtomRule: DriftRule = {
  id: "DRIFT-MISCLASSIFIED-ATOM",
  severity: "error",
  description: "File declares meta.kind=atom but classifier says otherwise",
  detect,
  fixable: false,
};
