import type { Tier, TierVerdict } from "./classifier.js";

export type DriftRuleId =
  | "DRIFT-MISPLACED"
  | "DRIFT-MISCLASSIFIED-ATOM"
  | "DRIFT-MISCLASSIFIED-COMPOSITE"
  | "DRIFT-DS-IMPORTS-FEATURE";

export interface DriftFinding {
  ruleId: DriftRuleId;
  file: string;
  message: string;
}

export interface DriftRuleInput {
  /** Relative file path, e.g. "design-system/atoms/button.tsx" */
  file: string;
  classifierVerdict: TierVerdict;
  /** Tier inferred from the file's folder location, or null if not under a known DS tier dir. */
  locationTier: Tier | null;
}

const RULE_REGISTRY: Record<DriftRuleId, string> = {
  "DRIFT-MISPLACED": "File lives in a folder that disagrees with its classifier-computed tier",
  "DRIFT-MISCLASSIFIED-ATOM": "File declares meta.kind=atom but classifier says otherwise",
  "DRIFT-MISCLASSIFIED-COMPOSITE": "File declares meta.kind=composite but classifier says otherwise",
  "DRIFT-DS-IMPORTS-FEATURE": "Design-system file imports from a domain root (features/, lib/, or configured domain root) — domain code must not pollute the DS",
};

export function ruleDescription(id: DriftRuleId): string {
  return RULE_REGISTRY[id];
}

export function allRuleIds(): DriftRuleId[] {
  return Object.keys(RULE_REGISTRY) as DriftRuleId[];
}

/** DRIFT-MISPLACED: file's folder tier ≠ classifier verdict. */
function evalMisplaced(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, classifierVerdict } = input;
  if (locationTier === null) return null;
  if (locationTier === classifierVerdict.tier) return null;
  return {
    ruleId: "DRIFT-MISPLACED",
    file,
    message:
      `located in ${locationTier}s/ but classifier says ${classifierVerdict.tier}` +
      ` (${classifierVerdict.signals.join("; ")})`,
  };
}

/** DRIFT-DS-IMPORTS-FEATURE: DS file whose classifier verdict is feature. */
function evalDsImportsFeature(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, classifierVerdict } = input;
  if (locationTier === null) return null;
  if (classifierVerdict.tier !== "feature") return null;
  return {
    ruleId: "DRIFT-DS-IMPORTS-FEATURE",
    file,
    message:
      `design-system file imports from domain root` +
      ` (${classifierVerdict.signals.join("; ")})`,
  };
}

/** Evaluate all registered drift rules against a single file's signals. */
export function evaluateDrift(input: DriftRuleInput): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const misplaced = evalMisplaced(input);
  if (misplaced) findings.push(misplaced);
  const dsImportsFeature = evalDsImportsFeature(input);
  if (dsImportsFeature) findings.push(dsImportsFeature);
  return findings;
}
