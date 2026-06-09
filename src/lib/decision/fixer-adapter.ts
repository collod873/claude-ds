import type { FindingKey, FixerDecisionPoint } from "../drift/decisions.js";
import type { Decision, DecisionId } from "./types.js";

/**
 * Bridge between the legacy per-finding `FixerDecisionPoint` (PRD #266 — the
 * fixer-only ancestor of the spine) and the spine's `Decision`. Every fixer
 * question is an Ambiguity by construction: the Simple-question test was the
 * gate that elevated a question to fixer-pre-pass status in the first place
 * (ADR-0023 amends ADR-0014). Per-finding answers continue to live on
 * `ctx.decisions.fixerChoices` so existing `fix()` bodies don't change; the
 * spine sits in front of them at the command-level pre-pass.
 *
 * The composite id `"${findingKey}::${point.key}"` keeps Decisions globally
 * unique across findings — the `--answers` bag is flat — without breaking the
 * `FindingKey × DecisionKey` lookup the fixers do.
 */
export function fixerDecisionId(finding: FindingKey, point: FixerDecisionPoint): DecisionId {
	return `${finding}::${point.key}`;
}

export function decisionFromFixerPoint(finding: FindingKey, point: FixerDecisionPoint): Decision {
	return {
		id: fixerDecisionId(finding, point),
		kind: "ambiguity",
		question: point.question,
		options: point.options.map((o) => ({ label: o.label, description: o.description })),
	};
}
