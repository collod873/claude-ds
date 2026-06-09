import {
	type AnswerBag,
	type Decision,
	type DecisionAnswer,
	type DecisionId,
	type DecisionOption,
	type PendingDecision,
	UnresolvedAmbiguityError,
} from "./types.js";

/**
 * Injected dependencies / mode flags for `resolveDecisions`. The resolver
 * itself performs no I/O — `isTTY` is a flag, the prompt is a callback. This
 * is the test seam: feed answers + assert outcomes; pure unit test, no pty.
 */
export interface ResolveEnv {
	/** True iff the caller is attached to a TTY (stdout + stdin both). */
	isTTY: boolean;
	/**
	 * TTY prompt callback. Required when `isTTY` is true and any Decision
	 * reaches the prompt path. Returns the option index the user chose or
	 * `"defer"` to skip.
	 */
	prompt?: (question: string, options: DecisionOption[]) => Promise<DecisionAnswer>;
	/**
	 * When true, unresolved non-TTY Ambiguities are collected as
	 * `PendingDecision`s instead of throwing. `heal` runs in this mode so a
	 * single sweep gathers every unresolved Decision into one batch report;
	 * `audit` and every other command leaves it false → fail loud.
	 */
	collect?: boolean;
}

export interface ResolveResult {
	/** Resolved Decisions, keyed by Decision id. */
	answers: Record<DecisionId, DecisionAnswer>;
	/** Unresolved Ambiguities collected when `env.collect` was true. */
	pending: PendingDecision[];
}

/**
 * The three-kind matrix (ADR-0023). One pass over the Decision list; for each
 * one the lookup order is supplied answer → kind-specific behavior.
 *
 * `commitment-gate`: TTY prompts (one approve per command); non-TTY auto-
 * applies the default option (git is the undo).
 * `ambiguity`:        TTY prompts; non-TTY fails loud (named throw) unless
 *                     the caller opted into `collect: true`.
 * `automatable`:      always returns the default option, no prompt.
 *
 * Throws `UnresolvedAmbiguityError` (named, with id + question) for the
 * non-TTY Ambiguity fail-loud path. The CLI top-level handler converts the
 * throw to a non-zero exit + plain-language print.
 */
export async function resolveDecisions(
	decisions: Decision[],
	supplied: AnswerBag,
	env: ResolveEnv,
): Promise<ResolveResult> {
	const answers: Record<DecisionId, DecisionAnswer> = {};
	const pending: PendingDecision[] = [];

	for (const d of decisions) {
		if (Object.hasOwn(supplied, d.id)) {
			answers[d.id] = supplied[d.id];
			continue;
		}

		switch (d.kind) {
			case "automatable": {
				answers[d.id] = d.defaultIndex ?? 0;
				break;
			}
			case "commitment-gate": {
				if (env.isTTY && env.prompt) {
					answers[d.id] = await env.prompt(d.question, d.options);
				} else {
					answers[d.id] = d.defaultIndex ?? 0;
				}
				break;
			}
			case "ambiguity": {
				if (env.isTTY && env.prompt) {
					answers[d.id] = await env.prompt(d.question, d.options);
				} else if (env.collect) {
					pending.push({ id: d.id, question: d.question, options: d.options });
				} else {
					throw new UnresolvedAmbiguityError(d.id, d.question);
				}
				break;
			}
		}
	}

	return { answers, pending };
}
