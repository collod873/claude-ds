import type { PromptOption } from "./prompt.js";

/**
 * Per-finding decision-point foundation for lifting prompts out of `plan()`
 * (PRD #266 Phase C step 1). The interactive arm of `DriftRule` exposes a pure
 * `describeDecisions(finding, source, opts)` that enumerates the questions the
 * fixer might ask; a future command-level pre-pass will ask them all up front
 * and write answers to `ctx.decisions.fixerChoices` so `fix()` becomes a pure
 * function of `(finding, ctx)`.
 *
 * Nothing reads `fixerChoices` yet — this step ships only the type seam and
 * the per-rule `describeDecisions` implementations.
 */

/** Stable per-finding identifier: `"${ruleId}:${file}"`. Shared with the audit-fix bookkeeping. */
export type FindingKey = string;

/** Per-fixer decision identifier, scoped to a single finding. */
export type DecisionKey = string;

/** Either the index of the chosen option, or `"defer"` (skip, add an exception). */
export type DecisionAnswer = number | "defer";

/**
 * One question a fixer might ask the consumer. The fix() body looks up
 * `ctx.decisions.fixerChoices[findingKey][key]` instead of calling
 * `opts.prompt(question, options)` directly.
 */
export interface FixerDecisionPoint {
	key: DecisionKey;
	question: string;
	options: PromptOption[];
}

/** Canonical key for a (rule, file) pair — `"${ruleId}:${file}"`. */
export function findingKey(finding: { ruleId: string; file: string }): FindingKey {
	return `${finding.ruleId}:${finding.file}`;
}
