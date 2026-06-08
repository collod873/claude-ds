import { isSmartPartFromSource } from "./three-signal.js";
import { DEFAULT_DOMAIN_ROOTS } from "./classifier.js";

const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g;

function importsFromDomainRoot(source: string, domainRoots: string[]): boolean {
  for (const root of domainRoots) {
    const escaped = root.replace(REGEX_META_RE, "\\$&");
    const re = new RegExp(`from\\s+["'][^"']*\\/${escaped}\\/`);
    if (re.test(source)) return true;
  }
  return false;
}

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
 *
 * Detection covers BOTH the literal anchor and library-applied roles, now that
 * the multi-part contract model exists (ADR-0024). A literal `role="combobox"`
 * in the source is the unambiguous single-component case; an `import … from
 * "cmdk"` is the headless-lib case (cmdk / base-ui / radix apply
 * `role="combobox"` at runtime, so it never appears as source text — see the
 * `IMPORT_PATTERNS` rationale below).
 *
 * Broadening to the import heuristic was previously forbidden (ADR-0022 §2):
 * with only a single-component runner, stamping a role the runner couldn't
 * drive turned a green soft-skip into a RED failure on real consumers —
 * strictly worse. That coupling is now satisfied. Detection and the runner
 * moved together (ADR-0024): a stamped role with no composed `contractExamples`
 * mount lands in the runner's `pending` arm — a GREEN, resolvable soft-skip —
 * never a red failure. So the import heuristic ships here, lock-step with the
 * multi-part model, exactly as ADR-0022 required. Read ADR-0024 before changing.
 */
const ROLE_PATTERNS: { role: string; anchor: RegExp }[] = [
  // `role="combobox"` is the WAI-APG anchor the shipped combobox contract
  // selects on (`container.querySelector('[role="combobox"]')`). If a smart
  // part renders that attribute, it is — by definition — claiming to be a
  // combobox, so the proposal is unambiguous.
  { role: "combobox", anchor: /\brole\s*=\s*['"]combobox['"]/ },
];

/**
 * Import-based role anchors for headless libraries that apply the ARIA role at
 * runtime, so no literal `role="..."` ever appears in the source (ADR-0024,
 * issue #461). Matched only on smart parts (the presentational guard runs
 * first), so a pure re-export or type shim never trips it.
 *
 * `cmdk` is the combobox engine itself — `import { Command } from "cmdk"` is a
 * near-unambiguous "this part IS a combobox/command widget" signal, and command
 * palettes are comboboxes under WAI-APG, so the proposal holds even for the
 * palette framing. We key on `cmdk` rather than the more generic base-ui
 * popover import (a popover is not necessarily a combobox) to keep the
 * false-positive rate near zero. A stamped-but-unmounted combobox is safe
 * regardless: it soft-skips green until the consumer authors a composed mount.
 */
const IMPORT_PATTERNS: { role: string; anchor: RegExp }[] = [
  { role: "combobox", anchor: /\bfrom\s+['"]cmdk['"]/ },
];

/**
 * The kind of proposal `proposeRole` returns. Discriminated so the caller
 * (`classify`) can branch on the shape without re-classifying:
 *
 *   - `role`              — the smart part's markup carries a shipped-role
 *                           ARIA anchor; `classify` may inject `meta.role`.
 *   - `candidate-feature` — smart part with no shipped role AND it imports
 *                           from a configured domain root (ADR-0005 import
 *                           predicate). `classify` surfaces this as a
 *                           relocate-to-features/ candidate.
 *   - `tracked-exception` — smart part with no shipped role AND no domain
 *                           imports. PRD #340 F7 default: presence of state
 *                           alone never brands a file as a feature. The
 *                           operator triages as presentational or registers
 *                           a tracked `exceptions.json` entry (per ADR-0003).
 */
export type RoleProposal =
  | { kind: "role"; role: string }
  | { kind: "candidate-feature" }
  | { kind: "tracked-exception" };

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
 *   2. ARIA anchor match (literal `role="combobox"`) OR a headless-lib import
 *      anchor (`cmdk`) → `{ kind: "role", role }`. The literal anchor is the
 *      single-component case; the import anchor is the runtime-applied-role
 *      case the multi-part runner now handles (ADR-0024). A positive proposal
 *      means the contract *can* drive the part once a composed mount exists; if
 *      none exists yet the runner soft-skips green, never red.
 *   3. Smart, no shipped role, AND imports from a configured domain root →
 *      `{ kind: "candidate-feature" }`. The ADR-0005 import predicate fires
 *      so the relocate-to-`features/` hand-off is real.
 *   4. Smart, no shipped role, no domain imports → `{ kind: "tracked-exception" }`.
 *      PRD #340 F7: presence of state alone is not a feature signal. The
 *      file defaults to a tracked exception (or the operator may mark it
 *      presentational); the tool never brands it "relocate to features/".
 *
 * Returning `null` for presentational parts is deliberate: the caller only
 * walks files without `meta.role`, and silently doing nothing on a
 * presentational atom is the correct outcome (it never needed a role).
 */
export function proposeRole(
  source: string,
  domainRoots: string[] = DEFAULT_DOMAIN_ROOTS,
): RoleProposal | null {
  if (!isSmartPartFromSource(source)) return null;
  for (const { role, anchor } of ROLE_PATTERNS) {
    if (anchor.test(source)) return { kind: "role", role };
  }
  for (const { role, anchor } of IMPORT_PATTERNS) {
    if (anchor.test(source)) return { kind: "role", role };
  }
  if (importsFromDomainRoot(source, domainRoots)) {
    return { kind: "candidate-feature" };
  }
  return { kind: "tracked-exception" };
}
