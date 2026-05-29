import type { Tier, TierVerdict } from "../classifier.js";
import type { DriftRuleId } from "../drift-rules.js";
import type { Change } from "../operation.js";
import type { Severity } from "../severity.js";
import type { FixerPrompt } from "./prompt.js";

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
