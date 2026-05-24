import type { Tier, TierVerdict } from "./classifier.js";

/**
 * Stable public vocabulary for drift rule IDs (ADR-0006).
 * Entries are valid across pack versions — do not remove or rename.
 * Add new IDs here when a new rule ships; guard unimplemented rules
 * with a comment so consumers can reference them in exceptions.json
 * before the evaluator logic lands.
 */
export type DriftRuleId =
  // Tier-placement rules (three-signal checker)
  | "DRIFT-MISPLACED"
  | "DRIFT-MISCLASSIFIED-ATOM"
  | "DRIFT-MISCLASSIFIED-COMPOSITE"
  // Meta declaration rule (requires meta_kind_strict in config)
  | "DRIFT-META-KIND-MISSING"
  // Feature-boundary rule
  | "DRIFT-DS-IMPORTS-FEATURE"
  // Patterns-tier rules (evaluator not yet wired; IDs stable for exceptions.json)
  | "DRIFT-PATTERN-NO-SLOTS"
  | "DRIFT-PATTERN-IMPORTS-PATTERN"
  // Code-quality drift rules (evaluators not yet wired; IDs stable)
  | "DRIFT-RAW-PRIMITIVE"
  | "DRIFT-CVA-VARIANT-UNRENDERED"
  | "DRIFT-INLINE-STATIC-STYLE";

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
  /** Tier from the file's exported meta.kind, null if absent. */
  metaKind: Tier | null;
  /** When true, DRIFT-META-KIND-MISSING fires on DS files that lack meta.kind. */
  metaKindStrict?: boolean;
}

const RULE_REGISTRY: Record<DriftRuleId, string> = {
  "DRIFT-MISPLACED":
    "File lives in a folder that disagrees with its classifier-computed tier",
  "DRIFT-MISCLASSIFIED-ATOM":
    "File declares meta.kind=atom but classifier says otherwise",
  "DRIFT-MISCLASSIFIED-COMPOSITE":
    "File declares meta.kind=composite but classifier says otherwise",
  "DRIFT-META-KIND-MISSING":
    "Design-system file is missing a meta.kind declaration (required after classify backfill)",
  "DRIFT-DS-IMPORTS-FEATURE":
    "Design-system file imports from a domain root (features/, lib/, or configured domain root) — domain code must not pollute the DS",
  "DRIFT-PATTERN-NO-SLOTS":
    "Pattern-tier file does not export children or named slot props",
  "DRIFT-PATTERN-IMPORTS-PATTERN":
    "Pattern-tier file imports from another pattern, violating the no-nested-patterns rule",
  "DRIFT-RAW-PRIMITIVE":
    "File renders a raw HTML primitive instead of its design-system atom equivalent",
  "DRIFT-CVA-VARIANT-UNRENDERED":
    "CVA variant defined in meta.variants is not exercised by any meta.examples entry",
  "DRIFT-INLINE-STATIC-STYLE":
    "File uses inline style={} with a literal value that should be a design token",
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

/** DRIFT-META-KIND-MISSING: DS file with no meta.kind when strict mode is on. */
function evalMetaKindMissing(input: DriftRuleInput): DriftFinding | null {
  if (!input.metaKindStrict) return null;
  const { file, locationTier, metaKind } = input;
  if (locationTier === null) return null;
  if (metaKind !== null) return null;
  return {
    ruleId: "DRIFT-META-KIND-MISSING",
    file,
    message: "missing meta.kind declaration — run `claude-ds classify` to backfill",
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
  const metaKindMissing = evalMetaKindMissing(input);
  if (metaKindMissing) findings.push(metaKindMissing);
  const misplaced = evalMisplaced(input);
  if (misplaced) findings.push(misplaced);
  const dsImportsFeature = evalDsImportsFeature(input);
  if (dsImportsFeature) findings.push(dsImportsFeature);
  return findings;
}
