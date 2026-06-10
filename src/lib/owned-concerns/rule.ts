import type { DriftRuleId } from "../drift/rule.js";
import type { IntegrityRuleId } from "../integrity/rule.js";

/**
 * Stable public vocabulary for Owned-concern IDs (ADR-0017).
 *
 * An Owned concern is a DS job claude-ds ships machinery for — paired with a
 * content detector and the pack capability that supersedes a hand-roll
 * (CONTEXT.md). The registry is the denominator the Completeness principle
 * (ADR-0003) measures against.
 *
 * IDs are part of the pack's public surface (referenced by `exceptions.json`
 * forever); do not remove or rename. Grows only when a real consumer
 * shadow-infra instance demands it (ADR-0017 grow-on-demand). The v1.7.0
 * Crewops dig (#505) is the evidence for the two base-ui / app-wide entries:
 * its hand-rolled `base-ui-aschild-validator.sh` and `ui-token-validator.sh`
 * are exactly the defect class this registry measures, and the v1.7.0 hooks
 * are their designated absorbers.
 */
export type OwnedConcernId =
	| "OWNED-TOKEN-LINT"
	| "OWNED-BASE-UI-ASCHILD-VALIDATOR"
	| "OWNED-APP-WIDE-TOKEN-LINT";

/**
 * A pack hook that supersedes a hand-rolled validator. The v1.7.0 hooks
 * (#465) are real shipped capabilities — `pre-write-base-ui.sh` (BASEUI-*)
 * and `pre-write-tokens-app-wide.sh` (TOK-*) — but they are opt-in gates,
 * inert unless the consumer's `design-system/enforcement.json` activates
 * them. A concern superseded by a hook therefore pairs its `supersededBy`
 * with `supersededByLiveWhen`: completeness may only advise removal once the
 * absorbing hook is actually live (ADR-0017 addendum — the false-delete
 * defect). IDs join the public rule-id surface alongside `DRIFT-` /
 * `INTEGRITY-` / `OWNED-`.
 */
export type HookCapabilityId = "HOOK-BASE-UI-ASCHILD" | "HOOK-TOKENS-APP-WIDE";

/**
 * The capability that supersedes a hand-rolled instance of this concern.
 * Mechanically constrained to an existing drift rule, integrity rule, or
 * pack hook so a concern cannot point at a capability the pack does not
 * actually ship.
 *
 * Nullable on `OwnedConcern` and `OwnedConcernFinding` (ADR-0017 addendum,
 * issue #348): `null` means "the concern is detectable but no shipped
 * capability covers the failure mode yet." Completeness flags such findings
 * as "possible shadow DS infra" instead of recommending removal — the
 * false-delete defect the addendum exists to kill (`scripts/lint-tokens.ts`
 * was almost deleted under the false claim that DRIFT-RAW-PRIMITIVE covered
 * its token-parity check). A hook superseder is additionally gated on the
 * hook being live (see `supersededByLiveWhen`): a dormant hook covers
 * nothing, so the scanner downgrades it to `null` (#505).
 */
export type SupersedingRuleId = DriftRuleId | IntegrityRuleId | HookCapabilityId;

/**
 * The `design-system/enforcement.json` flag that activates a hook superseder.
 * The scanner reads enforcement.json and, when the named key does not hold
 * the named value, treats the hook as inert and nulls out `supersededBy` for
 * the finding (#505). Only meaningful for hook-backed concerns.
 */
export interface EnforcementLiveness {
	key: "componentLib" | "tokenScope";
	value: string;
}

export interface OwnedConcernFinding {
	concernId: OwnedConcernId;
	file: string;
	supersededBy: SupersedingRuleId | null;
	message: string;
}

export interface OwnedConcernInput {
	/** Relative file path, e.g. "scripts/lint-tokens.ts". */
	file: string;
	/** Full source text. The detector reads this and the path only. */
	source: string;
}

/**
 * One Owned concern, co-locating its detect + metadata.
 *
 * `detect` is a pure function of `(content, path)`: no FS writes, no
 * consumer-code coupling, no side effects. Same discipline as `DriftRule.detect`.
 * Over-flag biased: when unsure, the rule flags and the consumer dismisses
 * via `exceptions.json` — the failure mode being killed is a silent
 * false-negative `✓ Completeness OK`.
 */
export interface OwnedConcern {
	id: OwnedConcernId;
	description: string;
	supersededBy: SupersedingRuleId | null;
	/**
	 * When the superseder is a pack hook, the enforcement flag that must be set
	 * for that hook to be live. The scanner downgrades `supersededBy` to `null`
	 * (→ "possible shadow DS infra", no removal advice) when the flag is unset,
	 * so completeness never tells a consumer to delete their only active guard
	 * while the absorbing hook lies dormant (#505 / ADR-0017 addendum).
	 */
	supersededByLiveWhen?: EnforcementLiveness;
	detect: (input: OwnedConcernInput) => OwnedConcernFinding | null;
}
