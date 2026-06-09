/**
 * The interaction spine for the CLI (ADR-0023 / PRD #325).
 *
 * Every choice the CLI surfaces is a **Decision** of one of three **kinds**;
 * the kind — not the command — picks behavior in the resolver matrix:
 *
 *   | Kind             | TTY                       | Non-TTY, no supplied answer |
 *   | commitment-gate  | colorized diff + approve  | auto-apply (git is undo)    |
 *   | ambiguity        | prompt                    | fail loud (named exit)      |
 *   | automatable      | silent safe default       | silent safe default         |
 *
 * `id` is stable and keyable like a rule id — it is the key in the `--answers`
 * JSON bag and in `ctx.decisions.answers`. `question`/`options` are plain-
 * language strings sized to pass the Simple-question test. Fixer call sites
 * keep their existing `FixerDecisionPoint` shape and are translated into
 * Decisions at the command-level pre-pass via `decisionFromFixerPoint`.
 */

export type DecisionKind = "commitment-gate" | "ambiguity" | "automatable";

/** Stable per-Decision identifier; the key in `--answers` and `ctx.decisions.answers`. */
export type DecisionId = string;

export interface DecisionOption {
	label: string;
	description: string;
}

export interface Decision {
	id: DecisionId;
	kind: DecisionKind;
	question: string;
	options: DecisionOption[];
	/**
	 * For `automatable` and (non-TTY) `commitment-gate`, the option index used
	 * when no answer is supplied. Defaults to 0 if omitted. Forbidden in spirit
	 * for `ambiguity` — an Ambiguity with a safe default would not be one — but
	 * not statically rejected so the resolver can still consume mixed batches.
	 */
	defaultIndex?: number;
}

/**
 * The answer the resolver records for a Decision. A number is an index into
 * `Decision.options`; `"defer"` is the explicit skip/no-op signal a fixer
 * reads back to record an exception.
 */
export type DecisionAnswer = number | "defer";

/** Pre-supplied answer bag keyed by `Decision.id` — the `--answers` shape. */
export type AnswerBag = Record<DecisionId, DecisionAnswer>;

/**
 * Unresolved Ambiguity in non-TTY, captured for a later batch-report rather
 * than thrown. `heal` uses this; everywhere else fails loud. Carries only the
 * fields a human/agent needs to fill in the `--answers` scaffold — no rule-id
 * jargon, no internal pointers.
 */
export interface PendingDecision {
	id: DecisionId;
	question: string;
	options: DecisionOption[];
}

/**
 * Thrown by `resolveDecisions` when a non-TTY caller hits a genuine Ambiguity
 * with no supplied answer and is not in collect mode. Named, with the
 * Decision id + question on the instance so a top-level handler can print
 * exactly what the operator needs to feed `--answers` next.
 */
export class UnresolvedAmbiguityError extends Error {
	readonly decisionId: DecisionId;
	readonly decisionQuestion: string;
	constructor(id: DecisionId, question: string) {
		super(`Unresolved Decision "${id}": ${question}`);
		this.name = "UnresolvedAmbiguityError";
		this.decisionId = id;
		this.decisionQuestion = question;
	}
}
