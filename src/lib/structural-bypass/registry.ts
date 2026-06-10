import type { StructuralBypass, StructuralBypassId } from "./rule.js";
import { badgeBypassRule } from "./rules/badge.js";
import { cardBypassRule } from "./rules/card.js";
import { toastBypassRule } from "./rules/toast.js";

/**
 * The structural-bypass registry indexed by id. Declared as
 * `Record<StructuralBypassId, StructuralBypass>` so the compiler enforces
 * totality — adding a new id to the `StructuralBypassId` union without adding
 * the matching signature here fails to build. Mirrors `DRIFT_RULES_BY_ID` /
 * `OWNED_CONCERNS_BY_ID`.
 *
 * Ships with exactly three evidence-backed entries (the Crewops hand-rolls in
 * issue #457). Grow-on-demand discipline lives in ADR-0017 (carried by
 * ADR-0026): a fourth signature lands only on real consumer bypass evidence,
 * accompanied by an ADR amendment. A pre-built signature library for atoms
 * nobody has bypassed is the speculative-infra failure mode the registry
 * exists to avoid.
 */
export const STRUCTURAL_BYPASSES_BY_ID: Record<StructuralBypassId, StructuralBypass> = {
	"BYPASS-CARD": cardBypassRule,
	"BYPASS-BADGE": badgeBypassRule,
	"BYPASS-TOAST": toastBypassRule,
};

/**
 * The structural-bypass registry as an ordered array — canonical evaluation
 * order. Derived from `STRUCTURAL_BYPASSES_BY_ID` so the typed record's
 * totality check propagates here; the array can't silently miss a signature.
 */
export const STRUCTURAL_BYPASSES: readonly StructuralBypass[] =
	Object.values(STRUCTURAL_BYPASSES_BY_ID);
