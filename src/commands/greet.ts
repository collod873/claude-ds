/**
 * First-run greet (PRD #325 sub-issue #334).
 *
 * Invoked from the bare-`claude-ds` action in `cli.ts` whenever no
 * `.claude-ds.json` exists. Detects framework + presence of consumer
 * components, surfaces a single Ambiguity Decision through the resolver
 * (ADR-0016), and dispatches to `initCmd` / `adoptCmd` in-process based on
 * the resolved answer.
 *
 * The resolver matrix gives this slice the same TTY/non-TTY semantics every
 * other Decision-bearing command has:
 *   - TTY: prompt via `makeTtyPrompt()` (one Ambiguity, one prompt).
 *   - Non-TTY + `--answers` carrying the greet's Decision id: resolve
 *     silently, dispatch.
 *   - Non-TTY + no supplied answer: `UnresolvedAmbiguityError` → named, non-
 *     zero exit pointing at `--answers` (caught here so the message is
 *     greet-specific rather than the generic top-level handler's stack).
 *
 * The dispatch is in-process — calling `initCmd` / `adoptCmd` directly — so
 * the chosen onramp runs in the same Node invocation without re-parsing
 * argv. Same pattern the front-door slice (#331) uses for `[Enter]` →
 * recommended next step.
 */
import { err } from "../lib/log.js";
import {
  loadAnswersFile,
  resolveDecisions,
  UnresolvedAmbiguityError,
  type AnswerBag,
  type DecisionAnswer,
  type DecisionOption,
} from "../lib/decision/index.js";
import {
  buildGreetDecision,
  detectFirstRun,
  DEFAULT_PACK,
  GREET_ADOPT_INDEX,
  GREET_DECISION_ID,
  GREET_INIT_INDEX,
} from "../lib/first-run.js";
import { isTTY } from "../lib/render/index.js";
import { makeTtyPrompt } from "../lib/drift/prompt.js";
import { adoptCmd } from "./adopt.js";
import { initCmd } from "./init.js";

export interface GreetOpts {
  cwd?: string;
  /** Path to a `--answers` JSON file (see `loadAnswersFile`). */
  answers?: string;
  /**
   * Test seam — when set, overrides `isTTY()` so unit/integration tests can
   * exercise both branches without poking `process.stdout.isTTY`. Production
   * callers pass nothing.
   */
  isTTYOverride?: boolean;
  /**
   * Test seam — when set, supplies a deterministic prompt callback in place
   * of `makeTtyPrompt()`. Lets tests drive the TTY arm by injecting an
   * answer without a real terminal. Production callers pass nothing.
   */
  prompt?: (question: string, options: DecisionOption[]) => Promise<DecisionAnswer>;
}

export async function greetCmd(opts: GreetOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();

  const state = await detectFirstRun(cwd);
  // Defensive: the cli entry already gates on `!hasConfig`, but a direct
  // caller (or a future test) could land here with a config in place. Bail
  // rather than overwrite the user's setup — the resolver would otherwise
  // happily route to init or adopt, both of which refuse on an existing
  // config anyway, but failing early gives a clearer message.
  if (state.hasConfig) {
    err("greet: .claude-ds.json already exists — run `claude-ds` for the dashboard, or a specific subcommand.");
    process.exit(2);
    return;
  }

  const decision = buildGreetDecision(state);

  let supplied: AnswerBag = {};
  if (opts.answers) {
    try {
      supplied = await loadAnswersFile(opts.answers);
    } catch (e) {
      err(e instanceof Error ? e.message : String(e));
      process.exit(2);
      return;
    }
  }

  const ttyMode = opts.isTTYOverride ?? isTTY();
  const prompt = opts.prompt ?? (ttyMode ? makeTtyPrompt() : undefined);

  let answer: DecisionAnswer;
  try {
    const result = await resolveDecisions([decision], supplied, {
      isTTY: ttyMode,
      prompt,
    });
    answer = result.answers[GREET_DECISION_ID];
  } catch (e) {
    if (e instanceof UnresolvedAmbiguityError) {
      err(`claude-ds needs you: decision "${e.decisionId}" — ${e.decisionQuestion}`);
      err(
        `Re-run with --answers <file> mapping "${e.decisionId}" to ${GREET_ADOPT_INDEX} (adopt) or ${GREET_INIT_INDEX} (init).`,
      );
      process.exit(2);
      return;
    }
    throw e;
  }

  // `"defer"` is a valid resolver outcome for an Ambiguity — the operator
  // pressed [s] at the prompt, or fed `"defer"` in `--answers`. Treat it as
  // "abort the greet" with a non-zero exit: dispatching to init or adopt on
  // an unanswered Decision is the silent-project-call ADR-0016 closes.
  if (answer === "defer") {
    err(`greet: decision "${GREET_DECISION_ID}" deferred — no onramp chosen.`);
    err(`Re-run with --answers <file> mapping "${GREET_DECISION_ID}" to ${GREET_ADOPT_INDEX} (adopt) or ${GREET_INIT_INDEX} (init).`);
    process.exit(2);
    return;
  }

  const pack = state.framework ?? DEFAULT_PACK;
  if (answer === GREET_ADOPT_INDEX) {
    await adoptCmd({ cwd, pack });
  } else if (answer === GREET_INIT_INDEX) {
    await initCmd({ cwd, pack, yes: true });
  } else {
    err(`greet: invalid answer index ${answer} for decision "${GREET_DECISION_ID}" — expected ${GREET_ADOPT_INDEX} or ${GREET_INIT_INDEX}.`);
    process.exit(2);
  }
}
