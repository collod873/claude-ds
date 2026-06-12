/**
 * Shared phrasing for the retirable / needs-review hand-rolled split (#639,
 * PRD #635 Module 3). Every surface that mentions the count renders from the
 * same `HandRolledSplit` and the same clause builders here, so the dashboard
 * headline can never promise a retirement the gate/closing/routing copy denies.
 *
 * ADR-0017's capability-gated-advice rule, already enforced in doctor detail
 * copy, now binds every surface: "the pack now provides" is said ONLY for
 * retirable findings (a live capability supersedes them); needs-review findings
 * render as "possible … to review" — flagged, never promised a retirement.
 *
 * Two dialects of the needs-review clause: the `Infra` variant (gate, closing,
 * routing) names "hand-rolled DS"; the `Plain` variant (the dashboard, #620)
 * stays free of internal vocabulary. Both render from the same split, so they
 * agree on the count and the classification, only the words differ.
 */

import type { HandRolledSplit } from "../hand-rolled-split.js";

function pluralize(n: number, noun: string): string {
	return n === 1 ? noun : `${noun}s`;
}

/**
 * The retirable clause, shared verbatim by all four surfaces — a live shipped
 * capability supersedes these, so "the pack now provides" is honest.
 */
export function retirableClause(split: HandRolledSplit): string {
	return `${split.retirable} ${pluralize(split.retirable, split.retirableNoun)} you built by hand that the design-system pack now provides`;
}

/**
 * The needs-review clause for the gate won't-fix block, closing summary, and
 * routing line — surfaces where the internal "hand-rolled DS" term is allowed.
 */
export function needsReviewInfraClause(split: HandRolledSplit): string {
	return `${split.needsReview} possible hand-rolled DS ${pluralize(split.needsReview, split.needsReviewNoun)} to review`;
}

/**
 * The needs-review clause for the dashboard (#620 consumer dialect — no
 * "hand-rolled"/"DS infra"/"finding" jargon). Same split, plain words.
 */
export function needsReviewPlainClause(split: HandRolledSplit): string {
	return `${split.needsReview} possible hand-built design-system ${pluralize(split.needsReview, split.needsReviewNoun)} to review`;
}
