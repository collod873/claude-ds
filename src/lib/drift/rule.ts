import type { Tier, TierVerdict } from "../classifier.js";
import type { Change } from "../operation.js";
import type { Severity } from "../severity.js";
import type { FixerPrompt } from "./prompt.js";

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

export interface FixResult {
  finding: DriftFinding;
  fixed: boolean;
  message: string;
  changes: Change[];
}

export interface FixerOpts {
  domainRoots?: string[];
  allowedImports?: string[];
  dsAliases?: string[];
  prompt?: FixerPrompt;
}

export type DriftFixer = (finding: DriftFinding, cwd: string, opts?: FixerOpts) => Promise<FixResult>;

/**
 * One drift rule, co-locating its detect + (optional) fix + metadata.
 *
 * Discriminated on `fixable`: a `fixable: true` rule MUST also declare
 * `fix`, `priority`, and `interactive`. A `fixable: false` rule MUST NOT
 * declare them. Forgetting `fix` on a fixable rule is a compile error —
 * this is the seam that prevents a silently-unfixable rule from shipping.
 */
export type DriftRule =
  | {
      id: DriftRuleId;
      severity: Severity;
      description: string;
      detect: (input: DriftRuleInput) => DriftFinding | null;
      fixable: false;
    }
  | {
      id: DriftRuleId;
      severity: Severity;
      description: string;
      detect: (input: DriftRuleInput) => DriftFinding | null;
      fixable: true;
      fix: DriftFixer;
      priority: number;
      interactive: boolean;
    };
