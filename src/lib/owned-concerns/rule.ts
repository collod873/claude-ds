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
 * forever); do not remove or rename. Ships with exactly one entry —
 * ADR-0017's grow-on-demand discipline. A new entry lands only when a real
 * consumer shadow-infra instance demands it.
 */
export type OwnedConcernId = "OWNED-TOKEN-LINT";

/**
 * The audit rule id that supersedes a hand-rolled instance of this concern.
 * Mechanically constrained to an existing drift or integrity rule so a
 * concern cannot point at a capability the pack does not actually ship.
 *
 * Nullable on `OwnedConcern` and `OwnedConcernFinding` (ADR-0017 addendum,
 * issue #348): `null` means "the concern is detectable but no shipped
 * capability covers the failure mode yet." Completeness flags such findings
 * as "possible shadow DS infra" instead of recommending removal — the
 * false-delete defect the addendum exists to kill (`scripts/lint-tokens.ts`
 * was almost deleted under the false claim that DRIFT-RAW-PRIMITIVE covered
 * its token-parity check).
 */
export type SupersedingRuleId = DriftRuleId | IntegrityRuleId;

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
  detect: (input: OwnedConcernInput) => OwnedConcernFinding | null;
}
