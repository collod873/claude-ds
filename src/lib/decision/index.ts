/**
 * The Decision spine (ADR-0023 / PRD #325). One barrel export — every
 * command-level pre-pass imports from here.
 */
export type {
  AnswerBag,
  Decision,
  DecisionAnswer,
  DecisionId,
  DecisionKind,
  DecisionOption,
  PendingDecision,
} from "./types.js";
export { UnresolvedAmbiguityError } from "./types.js";

export type { ResolveEnv, ResolveResult } from "./resolver.js";
export { resolveDecisions } from "./resolver.js";

export { renderDecision } from "./render.js";

export { loadAnswersFile } from "./answers-loader.js";

export { decisionFromFixerPoint, fixerDecisionId } from "./fixer-adapter.js";
