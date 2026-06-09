import type { OwnedConcern, OwnedConcernId } from "./rule.js";
import { ownedTokenLintRule } from "./rules/owned-token-lint.js";

/**
 * The Owned-concern registry indexed by id. Declared as
 * `Record<OwnedConcernId, OwnedConcern>` so the compiler enforces totality —
 * adding a new id to the `OwnedConcernId` union without adding the matching
 * concern here fails to build. Mirrors `DRIFT_RULES_BY_ID` /
 * `INTEGRITY_RULES_BY_ID`.
 *
 * Ships with exactly one entry. Grow-on-demand discipline lives in ADR-0017:
 * a second concern lands only on real consumer shadow-infra evidence,
 * accompanied by an updated ADR amendment. A pre-built detector library
 * for concerns nobody has shadowed is the speculative-infra failure mode
 * the registry exists to avoid.
 */
export const OWNED_CONCERNS_BY_ID: Record<OwnedConcernId, OwnedConcern> = {
	"OWNED-TOKEN-LINT": ownedTokenLintRule,
};

/**
 * The Owned-concern registry as an ordered array. Order is the canonical
 * evaluation order — the scanner runs each concern's `detect` in this
 * sequence and pushes non-null findings, so `doctor`'s coverage footer
 * (Map insertion order) is determined here.
 *
 * Derived from `OWNED_CONCERNS_BY_ID` so the typed record's totality check
 * propagates here — the array can't silently miss a concern.
 */
export const OWNED_CONCERNS: readonly OwnedConcern[] = Object.values(OWNED_CONCERNS_BY_ID);
