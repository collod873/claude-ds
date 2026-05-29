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
  // Legacy field cleanup
  | "DRIFT-STALE-META-STATES"
  // Code-quality drift rules (IDs stable)
  | "DRIFT-RAW-PRIMITIVE"
  | "DRIFT-CVA-VARIANT-UNRENDERED"
  | "DRIFT-INLINE-STATIC-STYLE"
  | "DRIFT-META-EXAMPLES-DUPLICATE"
  | "DRIFT-META-EXAMPLES-CORRUPT"
  | "DRIFT-STALE-DS-IMPORT";

export interface DriftFinding {
  ruleId: DriftRuleId;
  file: string;
  message: string;
}

/**
 * Stable marker embedded in a DRIFT-RAW-PRIMITIVE remediation message when the
 * fixer hit an inline component it can't replace and is deferring the structural
 * decision to `classify` (ADR-0015). Both the fixer that emits the finding and
 * the breadcrumb logic that routes on it reference this single constant so the
 * two never drift apart.
 */
export const EXTRACTION_NEEDED_MARKER = "needs extraction";

/** True when a finding is a DRIFT-RAW-PRIMITIVE that `audit` deferred to `classify`. */
export function isExtractionNeededFinding(f: { ruleId: string; message: string }): boolean {
  return f.ruleId === "DRIFT-RAW-PRIMITIVE" && f.message.includes(EXTRACTION_NEEDED_MARKER);
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
  /** Detected DS path aliases (e.g. ["@ds"]). */
  dsAliases?: string[];
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
  "DRIFT-META-EXAMPLES-DUPLICATE":
    "meta.examples contains duplicate entries (identical name + props)",
  "DRIFT-META-EXAMPLES-CORRUPT":
    "meta.examples has unbalanced braces — entries truncated by a prior dedup fix",
  "DRIFT-STALE-DS-IMPORT":
    "File imports via @/design-system/ instead of the canonical @ds/ alias",
  "DRIFT-STALE-META-STATES":
    "meta object contains a retired `states` field (ADR-0007) — strip it",
};

export function ruleDescription(id: DriftRuleId): string {
  return RULE_REGISTRY[id];
}

export function allRuleIds(): DriftRuleId[] {
  return Object.keys(RULE_REGISTRY) as DriftRuleId[];
}

export type { Severity } from "./severity.js";
import type { Severity } from "./severity.js";

const SEVERITY_MAP: Record<DriftRuleId, Severity> = {
  "DRIFT-MISPLACED": "error",
  "DRIFT-MISCLASSIFIED-ATOM": "error",
  "DRIFT-MISCLASSIFIED-COMPOSITE": "error",
  "DRIFT-META-KIND-MISSING": "error",
  "DRIFT-DS-IMPORTS-FEATURE": "error",
  "DRIFT-PATTERN-NO-SLOTS": "error",
  "DRIFT-PATTERN-IMPORTS-PATTERN": "error",
  "DRIFT-RAW-PRIMITIVE": "error",
  "DRIFT-CVA-VARIANT-UNRENDERED": "error",
  "DRIFT-INLINE-STATIC-STYLE": "error",
  "DRIFT-META-EXAMPLES-DUPLICATE": "error",
  "DRIFT-META-EXAMPLES-CORRUPT": "error",
  "DRIFT-STALE-DS-IMPORT": "error",
  "DRIFT-STALE-META-STATES": "error",
};

export function ruleSeverity(id: DriftRuleId): Severity {
  return SEVERITY_MAP[id];
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

const NAMED_COMPONENT_START_RE = /^function\s+([A-Z][A-Za-z0-9]+)\s*\(/gm;

export interface InternalComponent {
  name: string;
  startIndex: number;
  endIndex: number;
  body: string;
}

function extractFullFunction(source: string, start: number): string {
  let parenDepth = 0;
  let braceDepth = 0;
  let foundOpenParen = false;
  let pastParams = false;
  let foundBodyOpen = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (!pastParams) {
      if (c === "(") { parenDepth++; foundOpenParen = true; }
      if (c === ")" && foundOpenParen) {
        parenDepth--;
        if (parenDepth === 0) pastParams = true;
      }
      continue;
    }
    if (c === "{") { braceDepth++; foundBodyOpen = true; }
    if (c === "}") {
      braceDepth--;
      if (foundBodyOpen && braceDepth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

/**
 * Find non-exported, ≥20-line `function PascalCase(...)` declarations — the
 * inline components that `audit` can't replace in place and must defer to
 * `classify` for extraction (ADR-0015). Lives on the rule layer so both the
 * DRIFT-RAW-PRIMITIVE detector and the fixer route on one definition.
 */
export function findInternalComponents(source: string): InternalComponent[] {
  const components: InternalComponent[] = [];
  NAMED_COMPONENT_START_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAMED_COMPONENT_START_RE.exec(source)) !== null) {
    const lineStart = source.lastIndexOf("\n", m.index) + 1;
    const beforeOnLine = source.slice(lineStart, m.index);
    if (/export\s+/.test(beforeOnLine)) continue;

    const funcBody = extractFullFunction(source, m.index);
    const lineCount = funcBody.split("\n").length;
    if (lineCount < 20) continue;

    components.push({
      name: m[1],
      startIndex: m.index,
      endIndex: m.index + funcBody.length,
      body: funcBody,
    });
  }
  return components;
}

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
  const plural = counts.size > 1 || [...counts.values()][0] > 1;

  // If the file defines an inline component, audit can't replace the primitive
  // in place — extraction is a structural decision owned by `classify` (ADR-0015).
  // Stamp the marker at detection time so it survives post-fix re-validation and
  // the breadcrumb routes to `classify`, not `audit --fix` (issue #207). The fixer
  // defers on the same `findInternalComponents` condition, keeping the two in sync.
  if (findInternalComponents(source).length > 0) {
    return {
      ruleId: "DRIFT-RAW-PRIMITIVE",
      file,
      message: `raw HTML primitive${plural ? "s" : ""}: ${parts.join(", ")} — ${EXTRACTION_NEEDED_MARKER}, run \`claude-ds classify\` to extract the inline component into design-system/atoms/`,
    };
  }

  return {
    ruleId: "DRIFT-RAW-PRIMITIVE",
    file,
    message: `raw HTML primitive${plural ? "s" : ""}: ${parts.join(", ")} — use design-system atoms instead`,
  };
}

const PSEUDO_STATE_AXES = new Set([
  "hover", "focus", "active", "disabled", "checked", "selected",
  "visited", "pressed", "expanded", "visible", "open", "closed",
  "dark", "light", "focusVisible", "focusWithin",
]);

/**
 * Extract CVA variant axis names and their values from source.
 * Matches the variants object inside a cva() call.
 * Filters out pseudo-state axes (hover, focus, active, etc.) that are
 * CSS state selectors, not settable props.
 */
export function parseCvaVariants(source: string): Record<string, string[]> | null {
  if (!source.includes("cva(")) return null;

  const broadMatch = source.match(/variants\s*:\s*\{([\s\S]*?)\}\s*(?:,\s*(?:defaultVariants|compoundVariants)|,?\s*\}\s*\))/);
  if (!broadMatch) return null;

  const varBlock = broadMatch[1];
  const result: Record<string, string[]> = {};

  // Brace-balanced extraction of top-level axis blocks
  const axisStartRe = /(\w+)\s*:\s*\{/g;
  let am: RegExpExecArray | null;
  while ((am = axisStartRe.exec(varBlock)) !== null) {
    const axisName = am[1];
    if (PSEUDO_STATE_AXES.has(axisName)) continue;

    // Walk forward from the opening { to find the balanced closing }
    let depth = 1;
    let i = am.index + am[0].length;
    while (i < varBlock.length && depth > 0) {
      if (varBlock[i] === "{") depth++;
      else if (varBlock[i] === "}") depth--;
      i++;
    }
    if (depth !== 0) continue;

    const axisBody = varBlock.slice(am.index + am[0].length, i - 1);

    // Extract only top-level keys (depth-0 `word:` patterns, outside strings)
    const valueKeySet = new Set<string>();
    const keyRe = /(\w+)\s*:/g;
    let km: RegExpExecArray | null;
    while ((km = keyRe.exec(axisBody)) !== null) {
      const prefix = axisBody.slice(0, km.index);
      let d = 0;
      let inStr: string | null = null;
      for (const ch of prefix) {
        if (inStr) { if (ch === inStr) inStr = null; continue; }
        if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
        if (ch === "{" || ch === "[" || ch === "(") d++;
        else if (ch === "}" || ch === "]" || ch === ")") d--;
      }
      if (d === 0 && !inStr) valueKeySet.add(km[1]);
    }
    if (valueKeySet.size > 0) {
      result[axisName] = [...valueKeySet];
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

  const examplesContent = extractExamplesContent(source);
  if (!examplesContent) return exercised;

  for (const axis of axes) {
    const re = new RegExp(`${axis}\\s*:\\s*["']([^"']+)["']`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(examplesContent)) !== null) {
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

// Find the content between `examples: [` and its matching `]`, handling nested brackets.
function extractExamplesContent(source: string): string | null {
  const opener = /examples\s*:\s*\[/.exec(source);
  if (!opener) return null;
  let depth = 1;
  const start = opener.index + opener[0].length;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) return source.slice(start, i);
    }
  }
  return null;
}

function extractBraceEntries(text: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        entries.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return entries;
}

/** DRIFT-META-EXAMPLES-DUPLICATE: meta.examples contains duplicate entries. */
function evalMetaExamplesDuplicate(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, source } = input;
  if (locationTier === null) return null;
  if (source === undefined) return null;

  const examplesContent = extractExamplesContent(source);
  if (!examplesContent) return null;

  const entries = extractBraceEntries(examplesContent).map(e => e.replace(/\s+/g, " "));

  const seen = new Set<string>();
  let duplicateCount = 0;
  for (const entry of entries) {
    if (seen.has(entry)) {
      duplicateCount++;
    } else {
      seen.add(entry);
    }
  }

  if (duplicateCount === 0) return null;
  return {
    ruleId: "DRIFT-META-EXAMPLES-DUPLICATE",
    file,
    message: `${duplicateCount} duplicate meta.examples entr${duplicateCount === 1 ? "y" : "ies"}`,
  };
}

/** DRIFT-META-EXAMPLES-CORRUPT: examples array has unbalanced braces (truncated entries). */
function evalMetaExamplesCorrupt(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, source } = input;
  if (locationTier === null) return null;
  if (source === undefined) return null;

  const content = extractExamplesContent(source);
  if (!content) return null;

  let depth = 0;
  for (const ch of content) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (depth === 0) return null;

  return {
    ruleId: "DRIFT-META-EXAMPLES-CORRUPT",
    file,
    message: `meta.examples has ${depth} unclosed brace${depth === 1 ? "" : "s"} — likely truncated entries from a prior dedup fix`,
  };
}

const META_STATES_RE = /\bstates\s*:\s*\{/;

/** DRIFT-STALE-META-STATES: meta contains retired `states` field (ADR-0007). */
function evalStaleMetaStates(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, source } = input;
  if (locationTier === null) return null;
  if (source === undefined) return null;
  if (!source.includes("export const meta")) return null;
  const metaMatch = source.match(/export\s+const\s+meta[\s:=]/);
  if (!metaMatch) return null;
  const afterMeta = source.slice(metaMatch.index!);
  if (!META_STATES_RE.test(afterMeta)) return null;
  return {
    ruleId: "DRIFT-STALE-META-STATES",
    file,
    message: "meta contains retired `states` field — remove per ADR-0007",
  };
}

const STALE_DS_IMPORT_RE = /from\s+["']@\/design-system\//;

/** DRIFT-STALE-DS-IMPORT: file uses @/design-system/ when @ds/ alias is available. */
function evalStaleDsImport(input: DriftRuleInput): DriftFinding | null {
  const { file, locationTier, source, dsAliases } = input;
  if (locationTier === null) return null;
  if (source === undefined) return null;
  const canonicalAliases = (dsAliases ?? []).filter(a => a !== "@/design-system");
  if (canonicalAliases.length === 0) return null;
  if (!STALE_DS_IMPORT_RE.test(source)) return null;

  const staleCount = (source.match(/from\s+["']@\/design-system\//g) ?? []).length;
  return {
    ruleId: "DRIFT-STALE-DS-IMPORT",
    file,
    message: `${staleCount} import${staleCount === 1 ? "" : "s"} use @/design-system/ instead of @ds/`,
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
  const metaExamplesDuplicate = evalMetaExamplesDuplicate(input);
  if (metaExamplesDuplicate) findings.push(metaExamplesDuplicate);
  const metaExamplesCorrupt = evalMetaExamplesCorrupt(input);
  if (metaExamplesCorrupt) findings.push(metaExamplesCorrupt);
  const staleDsImport = evalStaleDsImport(input);
  if (staleDsImport) findings.push(staleDsImport);
  const staleMetaStates = evalStaleMetaStates(input);
  if (staleMetaStates) findings.push(staleMetaStates);
  return findings;
}
