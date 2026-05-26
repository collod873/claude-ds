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

/** DRIFT-MISPLACED: file's folder tier ≠ classifier verdict.
 *  Pattern verdict is suppressed — pattern classification requires explicit
 *  declaration (meta.kind or directory placement). Use `classify` for discovery. */
function evalMisplaced(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, classifierVerdict } = input;
  if (locationTier === null) return null;
  if (locationTier === classifierVerdict.tier) return null;
  if (classifierVerdict.tier === "pattern") return null;
  return {
    ruleId: "DRIFT-MISPLACED",
    file,
    message:
      `located in ${locationTier}s/ but classifier says ${classifierVerdict.tier}` +
      ` (${classifierVerdict.signals.join("; ")})`,
  };
}

/** DRIFT-MISCLASSIFIED-ATOM: meta.kind=atom but classifier disagrees. */
function evalMisclassifiedAtom(input: DriftRuleInput): DriftFinding | null {
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

/** DRIFT-MISCLASSIFIED-COMPOSITE: meta.kind=composite but classifier disagrees. */
function evalMisclassifiedComposite(input: DriftRuleInput): DriftFinding | null {
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

/**
 * Match raw HTML primitives (<button, <input) in JSX.
 * Case-sensitive — PascalCase variants (<Button, <Input) are component refs, not raw HTML.
 * Captures the element name for counting.
 */
const RAW_PRIMITIVE_RE = /<(button|input)[\s>/]/g;

/** DRIFT-RAW-PRIMITIVE: composite/pattern using raw HTML primitive instead of atom. */
function evalRawPrimitive(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, source } = input;
  if (locationTier === null) return null;
  if (locationTier === "atom") return null;
  if (source === undefined) return null;

  const counts = new Map<string, number>();
  let m: RegExpExecArray | null;
  RAW_PRIMITIVE_RE.lastIndex = 0;
  while ((m = RAW_PRIMITIVE_RE.exec(source)) !== null) {
    const el = m[1];
    counts.set(el, (counts.get(el) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  const parts = [...counts.entries()].map(([el, n]) => `${n} <${el}>`);
  return {
    ruleId: "DRIFT-RAW-PRIMITIVE",
    file,
    message: `raw HTML primitive${counts.size > 1 || [...counts.values()][0] > 1 ? "s" : ""}: ${parts.join(", ")} — use design-system atoms instead`,
  };
}

/**
 * Extract CVA variant axis names and their values from source.
 * Matches the variants object inside a cva() call.
 */
function parseCvaVariants(source: string): Record<string, string[]> | null {
  if (!source.includes("cva(")) return null;

  const broadMatch = source.match(/variants\s*:\s*\{([\s\S]*?)\}\s*(?:,\s*(?:defaultVariants|compoundVariants)|,?\s*\}\s*\))/);
  if (!broadMatch) return null;

  const varBlock = broadMatch[1];
  const result: Record<string, string[]> = {};

  const axisRe = /(\w+)\s*:\s*\{([^}]*)\}/g;
  let am: RegExpExecArray | null;
  while ((am = axisRe.exec(varBlock)) !== null) {
    const axisName = am[1];
    const valuesBlock = am[2];
    const valueKeys: string[] = [];
    const keyRe = /(\w+)\s*:/g;
    let km: RegExpExecArray | null;
    while ((km = keyRe.exec(valuesBlock)) !== null) {
      valueKeys.push(km[1]);
    }
    if (valueKeys.length > 0) {
      result[axisName] = valueKeys;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Extract variant values exercised by meta.examples entries.
 * Scans each example's props for keys matching CVA axis names.
 */
function parseExercisedVariants(source: string, axes: string[]): Map<string, Set<string>> {
  const exercised = new Map<string, Set<string>>();
  for (const axis of axes) exercised.set(axis, new Set());

  const examplesMatch = source.match(/examples\s*:\s*\[([\s\S]*?)\]\s*(?:,|\})/);
  if (!examplesMatch) return exercised;

  for (const axis of axes) {
    const re = new RegExp(`${axis}\\s*:\\s*["']([^"']+)["']`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(examplesMatch[1])) !== null) {
      exercised.get(axis)!.add(m[1]);
    }
  }

  return exercised;
}

/** DRIFT-CVA-VARIANT-UNRENDERED: CVA variant value not exercised by any meta.examples entry. */
function evalCvaVariantUnrendered(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, source } = input;
  if (locationTier === null) return null;
  if (source === undefined) return null;

  const cvaVariants = parseCvaVariants(source);
  if (!cvaVariants) return null;

  // Empty examples is an authoritative stub signal — don't flag
  const examplesMatch = source.match(/examples\s*:\s*\[\s*\]/);
  if (examplesMatch) return null;

  const axes = Object.keys(cvaVariants);
  const exercised = parseExercisedVariants(source, axes);

  const unexercised: string[] = [];
  for (const axis of axes) {
    const exercisedValues = exercised.get(axis)!;
    for (const value of cvaVariants[axis]) {
      if (!exercisedValues.has(value)) {
        unexercised.push(`${axis}=${value}`);
      }
    }
  }

  if (unexercised.length === 0) return null;
  return {
    ruleId: "DRIFT-CVA-VARIANT-UNRENDERED",
    file,
    message: `${unexercised.length} unexercised CVA variant value${unexercised.length > 1 ? "s" : ""}: ${unexercised.join(", ")}`,
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
  const misclassifiedAtom = evalMisclassifiedAtom(input);
  if (misclassifiedAtom) findings.push(misclassifiedAtom);
  const misclassifiedComposite = evalMisclassifiedComposite(input);
  if (misclassifiedComposite) findings.push(misclassifiedComposite);
  const dsImportsFeature = evalDsImportsFeature(input);
  if (dsImportsFeature) findings.push(dsImportsFeature);
  const patternNoSlots = evalPatternNoSlots(input);
  if (patternNoSlots) findings.push(patternNoSlots);
  const patternImportsPattern = evalPatternImportsPattern(input);
  if (patternImportsPattern) findings.push(patternImportsPattern);
  const inlineStaticStyle = evalInlineStaticStyle(input);
  if (inlineStaticStyle) findings.push(inlineStaticStyle);
  const rawPrimitive = evalRawPrimitive(input);
  if (rawPrimitive) findings.push(rawPrimitive);
  const cvaVariantUnrendered = evalCvaVariantUnrendered(input);
  if (cvaVariantUnrendered) findings.push(cvaVariantUnrendered);
  return findings;
}
