import { OWNED_CONCERNS, OWNED_CONCERNS_BY_ID } from "./registry.js";
import type {
  OwnedConcernFinding,
  OwnedConcernId,
  OwnedConcernInput,
  SupersedingRuleId,
} from "./rule.js";

export type {
  OwnedConcern,
  OwnedConcernFinding,
  OwnedConcernId,
  OwnedConcernInput,
  SupersedingRuleId,
} from "./rule.js";

/**
 * Evaluate all registered Owned concerns against a single file's content.
 * Same shape as `evaluateDrift` / sync `evaluateIntegrity`: iterate the
 * registry, push every non-null finding. Pure over its input — no FS,
 * no consumer-code coupling.
 */
export function evaluateOwnedConcerns(
  input: OwnedConcernInput,
): OwnedConcernFinding[] {
  const findings: OwnedConcernFinding[] = [];
  for (const concern of OWNED_CONCERNS) {
    const finding = concern.detect(input);
    if (finding) findings.push(finding);
  }
  return findings;
}

/** All registered Owned-concern ids, in canonical registry order. */
export function allOwnedConcernIds(): OwnedConcernId[] {
  return OWNED_CONCERNS.map(c => c.id);
}

/** Human-readable description for an Owned-concern id. */
export function ownedConcernDescription(id: OwnedConcernId): string {
  return OWNED_CONCERNS_BY_ID[id].description;
}

/** The audit rule id that supersedes a hand-rolled instance of this concern. */
export function ownedConcernSupersededBy(
  id: OwnedConcernId,
): SupersedingRuleId {
  return OWNED_CONCERNS_BY_ID[id].supersededBy;
}
