import type { Tier, TierVerdict } from "./classifier.js";
import { hasSlotExports } from "./classifier.js";

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
  // Patterns-tier rules
  | "DRIFT-PATTERN-NO-SLOTS"
  | "DRIFT-PATTERN-IMPORTS-PATTERN"
  // Code-quality drift rules (IDs stable)
  | "DRIFT-RAW-PRIMITIVE"   // evaluator not yet wired
  | "DRIFT-CVA-VARIANT-UNRENDERED"  // evaluator not yet wired
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
  /** Full source text — required for source-level drift rules (DRIFT-PATTERN-NO-SLOTS). */
  source?: string;
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

/** DRIFT-PATTERN-NO-SLOTS: file under patterns/ does not export children or named slot props. */
function evalPatternNoSlots(input: DriftRuleInput): DriftFinding | null {
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

/**
 * Match a JSX style={{ ... }} where every property value is a static literal.
 * Uses a regex over the full pattern — matches only when ALL values are
 * primitives (strings, numbers, booleans, null/undefined). Exempt when any
 * value is a computed expression, variable, function call, spread, or
 * template literal with interpolation.
 */
const STATIC_STYLE_RE = new RegExp(
  "style\\s*=\\s*\\{\\{\\s*" +
  "(?:" +
    "[a-zA-Z_$][\\w$]*\\s*:\\s*" +
    "(?:" +
      "'(?:[^'\\\\]|\\\\.)*'" +     // single-quoted string
      '|"(?:[^"\\\\]|\\\\.)*"' +    // double-quoted string
      "|`[^`$]*`" +                  // template literal without expressions
      "|-?\\d+(?:\\.\\d+)?" +        // number (including negative/decimal)
      "|true|false|null|undefined" + // keyword literals
    ")" +
    "\\s*,?\\s*" +
  ")+" +
  "\\}\\}",
);

/** DRIFT-INLINE-STATIC-STYLE: inline style={{}} with all-literal values. */
function evalInlineStaticStyle(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, source } = input;
  if (locationTier === null) return null;
  if (source === undefined) return null;
  if (!STATIC_STYLE_RE.test(source)) return null;
  return {
    ruleId: "DRIFT-INLINE-STATIC-STYLE",
    file,
    message:
      "inline style={} with literal values — use design tokens instead",
  };
}

/** DRIFT-PATTERN-IMPORTS-PATTERN: pattern-tier file imports from another pattern. */
function evalPatternImportsPattern(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, classifierVerdict } = input;
  if (locationTier !== "pattern") return null;
  if (!classifierVerdict.signals.some(s => s.includes("design-system/patterns/"))) return null;
  return {
    ruleId: "DRIFT-PATTERN-IMPORTS-PATTERN",
    file,
    message: "pattern-tier file imports from design-system/patterns/ — patterns must not nest other patterns",
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
  const patternNoSlots = evalPatternNoSlots(input);
  if (patternNoSlots) findings.push(patternNoSlots);
  const patternImportsPattern = evalPatternImportsPattern(input);
  if (patternImportsPattern) findings.push(patternImportsPattern);
  const inlineStaticStyle = evalInlineStaticStyle(input);
  if (inlineStaticStyle) findings.push(inlineStaticStyle);
  return findings;
}
