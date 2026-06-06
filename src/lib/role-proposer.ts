import { isSmartPartFromSource } from "./three-signal.js";

/**
 * Closed list of role-proposal candidates the pack supports. Today this is
 * exactly the shipped contracts (`combobox`) — adding a role here without a
 * matching contract would have `classify` propose a role whose contract the
 * pack can't run, which is the speculative-infra failure mode ADR-0016
 * exists to prevent. So this list grows lock-step with `SHIPPED_ROLES` in
 * `drift/role-contracts.ts` and the pack's `Role` union.
 *
 * Each entry pairs a role name with the ARIA anchor regex that identifies a
 * source whose rendered DOM will carry that role's contract anchors. The
 * regex matches both single- and double-quoted attribute values — JSX accepts
 * either, and the proposer must not miss a combobox just because the consumer
 * prefers single quotes.
 */
const ROLE_PATTERNS: { role: string; anchor: RegExp }[] = [
  // `role="combobox"` is the WAI-APG anchor the shipped combobox contract
  // selects on (`container.querySelector('[role="combobox"]')`). If a smart
  // part renders that attribute, it is — by definition — claiming to be a
  // combobox, so the proposal is unambiguous.
  { role: "combobox", anchor: /\brole\s*=\s*['"]combobox['"]/ },
];

/**
 * The kind of proposal `proposeRole` returns. Discriminated so the caller
 * (`classify`) can branch on the shape without re-classifying:
 *
 *   - `role`             — the smart part's markup carries a shipped-role
 *                          ARIA anchor; `classify` may inject `meta.role`.
 *   - `candidate-feature` — smart part with no matching anchor. The
 *                          ADR-0005 hand-off: triage as presentational,
 *                          relocate to features/, or register a tracked
 *                          `exceptions.json` entry (per ADR-0003).
 */
export type RoleProposal =
  | { kind: "role"; role: string }
  | { kind: "candidate-feature" };

/**
 * Propose a `meta.role` for a design-system source file.
 *
 * Pure: regex-only over the source text. The proposer never reads or writes
 * files — turning a proposal into bytes is `classify`'s job, mirroring how
 * `classifySource` proposes a tier and `classify` (or `moveTierFile`) does
 * the actual move.
 *
 * Predicate order:
 *
 *   1. Presentational parts (no smart-part hook) → `null`. The role-contract
 *      system only governs *behavior*; a pure render-of-props is fully
 *      covered by the showcase mirror (ADR-0003).
 *   2. ARIA anchor match → `{ kind: "role", role }`. The same anchor the
 *      shipped contract selects on, so a positive proposal means the
 *      contract will be able to drive the component.
 *   3. Neither → `{ kind: "candidate-feature" }`. Smart, but no shipped
 *      contract fits — the consumer hands the file to the ADR-0005 path
 *      (`features/`, presentational, or tracked exception).
 *
 * Returning `null` for presentational parts is deliberate: the caller only
 * walks files without `meta.role`, and silently doing nothing on a
 * presentational atom is the correct outcome (it never needed a role).
 */
export function proposeRole(source: string): RoleProposal | null {
  if (!isSmartPartFromSource(source)) return null;
  for (const { role, anchor } of ROLE_PATTERNS) {
    if (anchor.test(source)) return { kind: "role", role };
  }
  return { kind: "candidate-feature" };
}
