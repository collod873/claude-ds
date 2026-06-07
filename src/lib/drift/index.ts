import { DRIFT_RULES, DRIFT_RULES_BY_ID } from "./registry.js";
import type {
  DescribeDecisions,
  DriftFinding,
  DriftFixer,
  DriftRuleId,
  DriftRuleInput,
} from "./rule.js";

export type {
  DescribeDecisions,
  DriftFinding,
  DriftFixer,
  DriftRuleId,
  DriftRuleInput,
  FixResult,
} from "./rule.js";
export type {
  DecisionAnswer,
  DecisionKey,
  FindingKey,
  FixerDecisionPoint,
} from "./decisions.js";
export { findingKey } from "./decisions.js";
export type { Severity } from "../severity.js";
export type { FixerPrompt, PromptOption } from "./prompt.js";
export type { InternalComponent } from "./rules/raw-primitive.js";

export { makeTtyPrompt } from "./prompt.js";
export { parseCvaVariants } from "./cva.js";
export {
  EXTRACTION_NEEDED_MARKER,
  findInternalComponents,
  isExtractionNeededFinding,
  buildVariantOptions,
  toKebab,
} from "./rules/raw-primitive.js";

/** Evaluate all registered drift rules against a single file's signals. */
export function evaluateDrift(input: DriftRuleInput): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const rule of DRIFT_RULES) {
    const finding = rule.detect(input);
    if (finding) findings.push(finding);
  }
  return findings;
}

/** All registered rule ids, in canonical registry order. */
export function allRuleIds(): DriftRuleId[] {
  return DRIFT_RULES.map(r => r.id);
}

/** Human-readable description for a rule id. */
export function ruleDescription(id: DriftRuleId): string {
  return DRIFT_RULES_BY_ID[id].description;
}

/** Severity for a rule id. */
export function ruleSeverity(id: DriftRuleId) {
  return DRIFT_RULES_BY_ID[id].severity;
}

/** True if the rule has a fixer. */
export function isFixable(id: DriftRuleId): boolean {
  return DRIFT_RULES_BY_ID[id].fixable;
}

/**
 * True if `classify` is the owning remedy for findings of this rule (#379).
 * Defined only for `fixable: false` rules — fixable rules answer "audit can
 * remedy this" via `isFixable`, so this predicate is meaningless for them
 * and returns `false`. Read by `deriveProjectState` to distinguish 'classify
 * can relocate this' from 'unfixable, no remedy', so heal's convergence
 * check can stay honest as new unfixable rules ship.
 */
export function isClassifyRelocatable(id: DriftRuleId): boolean {
  const rule = DRIFT_RULES_BY_ID[id];
  return rule.fixable ? false : rule.classifyRelocatable;
}

/** The rule's fixer if fixable, else `null`. */
export function getFixer(id: DriftRuleId): DriftFixer | null {
  const rule = DRIFT_RULES_BY_ID[id];
  return rule.fixable ? rule.fix : null;
}

/** True if the rule's fixer requires interactive input (a TTY prompt). */
export function isInteractive(id: DriftRuleId): boolean {
  const rule = DRIFT_RULES_BY_ID[id];
  return rule.fixable ? rule.interactive : false;
}

/**
 * The rule's pure decision-point enumerator if it's interactive, else `null`.
 * The command-level pre-pass (Phase C step 2+) uses this to enumerate the
 * questions a fixer would otherwise ask via `opts.prompt`. Today nothing
 * calls it; the hook exists so the type system can enforce that every
 * `fixable:true, interactive:true` rule supplies one (PRD #266 Phase C step 1).
 */
export function getDescribeDecisions(id: DriftRuleId): DescribeDecisions | null {
  const rule = DRIFT_RULES_BY_ID[id];
  return rule.fixable && rule.interactive ? rule.describeDecisions : null;
}

/**
 * Sort priority for a rule's fixer. Lower priority runs first; unfixable
 * rules return `Infinity` so they sort to the end (fix-pass relies on this).
 */
export function getFixerPriority(id: DriftRuleId): number {
  const rule = DRIFT_RULES_BY_ID[id];
  return rule.fixable ? rule.priority : Infinity;
}
