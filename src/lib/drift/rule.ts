import type { Tier, TierVerdict } from "../classifier.js";
import type { Change } from "../operation.js";
import type { ProjectContext } from "../project.js";
import type { Severity } from "../severity.js";
import type { FixerDecisionPoint } from "./decisions.js";

/**
 * Stable public vocabulary for drift rule IDs (ADR-0006).
 * Entries are valid across pack versions — do not remove or rename.
 * Add new IDs here when a new rule ships; guard unimplemented rules
 * with a comment so consumers can reference them in exceptions.json
 * before the evaluator logic lands.
 */
export type DriftRuleId =
  // Tier-placement rules (three-signal checker)
  | "DRIFT-MISPLACED"
  | "DRIFT-MISCLASSIFIED-ATOM"
  | "DRIFT-MISCLASSIFIED-COMPOSITE"
  // Meta declaration rule (requires meta_kind_strict in config)
  | "DRIFT-META-KIND-MISSING"
  // Role / behavior-contract rules (PRD #301 / #311)
  | "DRIFT-SMART-PART-NO-ROLE"
  | "DRIFT-ROLE-NO-CONTRACT"
  // Feature-boundary rule
  | "DRIFT-DS-IMPORTS-FEATURE"
  // Patterns-tier rules
  | "DRIFT-PATTERN-NO-SLOTS"
  | "DRIFT-PATTERN-IMPORTS-PATTERN"
  // Legacy field cleanup
  | "DRIFT-STALE-META-STATES"
  // Code-quality drift rules (IDs stable)
  | "DRIFT-RAW-PRIMITIVE"
  | "DRIFT-CVA-VARIANT-UNRENDERED"
  | "DRIFT-INLINE-STATIC-STYLE"
  | "DRIFT-META-EXAMPLES-DUPLICATE"
  | "DRIFT-META-EXAMPLES-CORRUPT"
  // Token-parity rule (PRD #340 / sub-issue #347; ADR-0017 addendum). Required
  // before OWNED-TOKEN-LINT can legitimately claim supersession of a hand-rolled
  // JSON↔CSS token-parity guard.
  | "DRIFT-TOKEN-PARITY";
// DRIFT-STALE-DS-IMPORT was retired with the ADR-0009 addendum
// (alias-agnostic enforcement). The rule flagged `@/design-system/*` as
// "stale" relative to `@ds/*` — i.e. the same forced canonical-form rewrite
// that motivated retiring the `rewrite-ds-imports` migration. Both alias
// spellings are now valid; nothing should normalize one to the other.

export interface DriftFinding {
  ruleId: DriftRuleId;
  file: string;
  message: string;
}

export interface DriftRuleInput {
  /** Relative file path, e.g. "design-system/atoms/button.tsx" */
  file: string;
  classifierVerdict: TierVerdict;
  /** Tier inferred from the file's folder location, or null if not under a known DS tier dir. */
  locationTier: Tier | null;
  /** Full source text — required for source-level drift rules (DRIFT-PATTERN-NO-SLOTS). */
  source?: string;
  /** Tier from the file's exported meta.kind, null if absent. */
  metaKind: Tier | null;
  /** When true, DRIFT-META-KIND-MISSING fires on DS files that lack meta.kind. */
  metaKindStrict?: boolean;
  /** Detected DS path aliases (e.g. ["@ds"]). */
  dsAliases?: string[];
  /** The `meta.role` value parsed from source, or `null` if absent. Populated for
   *  atom/composite files; null for pattern/reference. PRD #301 / #311. */
  metaRole?: string | null;
  /** True when the file's body uses React state/effect/context — the predicate
   *  that triggers DRIFT-SMART-PART-NO-ROLE when `roleContractsStrict` is on. */
  isSmartPart?: boolean;
  /** When true, DRIFT-SMART-PART-NO-ROLE fires on smart parts that declare no role.
   *  Mirrors `metaKindStrict` — default false on fresh adoption, flipped after
   *  classify backfill (PRD #301 / #311). */
  roleContractsStrict?: boolean;
  /** Flat map of CSS variable name → raw value string, pre-parsed by the audit
   *  pre-pass from the consumer's tokens-CSS file (commonly `app/globals.css`).
   *  Keys are the variable name *without* the leading `--` (e.g.
   *  `"color-primary"`); values are the raw declaration text. Required for
   *  DRIFT-TOKEN-PARITY to fire — when absent, the rule short-circuits to null
   *  rather than misreporting. See `src/lib/drift/rules/token-parity.ts`. */
  cssVariables?: Record<string, string>;
  /** Project-relative path the `cssVariables` map came from — surfaced in the
   *  DRIFT-TOKEN-PARITY finding message and read again by the fixer to update
   *  the same file. */
  cssVariablesFile?: string;
}

export interface FixResult {
  finding: DriftFinding;
  fixed: boolean;
  message: string;
  changes: Change[];
  /**
   * Opt-in collapse descriptor (#448). When many files get the SAME fix, the
   * per-file `fixed […]: …` lines are a brownfield wall — the `repetition`
   * friction the gate grades (PRD #439). A fixer sets this so `audit`/`heal`
   * collapse same-`(ruleId, label, group)` fixed results into one count line —
   * `fixed [DRIFT-META-KIND-MISSING]: added meta.kind to 16 files (atoms)` —
   * unless `--verbose` is set. `label` is the action; `group` is the bucket
   * (e.g. the tier) used both to partition the count and as the parenthetical
   * (pluralized with a trailing "s").
   */
  collapse?: { label: string; group: string };
}

/**
 * Drift fixer signature: a pure function of `(finding, ctx)`. PRD #266 Phase C
 * step 2 finalizes the surface — Phase A removed the bare `cwd` rationale,
 * Phase B folded `domainRoots`/`allowedImports`/`dsAliases` onto `ctx.auditConfig`,
 * and this step lifts the prompt to a command-level pre-pass that writes per-
 * finding answers into `ctx.decisions.fixerChoices`. The fixer reads those
 * answers via `ctx.decisions.fixerChoices?.[findingKey(finding)]?.[decisionKey]`
 * (missing entry → `"defer"`), so `plan(ctx)` is now provably deterministic
 * given its ctx. `FixerOpts` is deleted; nothing threads through alongside ctx.
 */
export type DriftFixer = (finding: DriftFinding, ctx: ProjectContext) => Promise<FixResult>;

/**
 * Pure enumerator of the questions a fixer might ask the consumer for a given
 * finding (PRD #266 Phase C step 1). Required on the `fixable:true,
 * interactive:true` arm of `DriftRule` and forbidden on the other arms —
 * forgetting it on a new interactive rule is a compile error.
 *
 * Pure: must not perform I/O beyond what `detect` already reads (the file
 * `source`) and must not prompt. The command-level pre-pass calls this to
 * decide what to ask up front; the fixer reads the answers from
 * `ctx.decisions.fixerChoices` instead of calling `opts.prompt`.
 */
export type DescribeDecisions = (
  finding: DriftFinding,
  source: string,
  opts: { ctx: ProjectContext },
) => FixerDecisionPoint[];

/**
 * One drift rule, co-locating its detect + (optional) fix + metadata.
 *
 * Discriminated on `fixable`: a `fixable: false` rule MUST NOT declare
 * `fix`/`priority`/`interactive`, but MUST declare `classifyRelocatable` —
 * the answer to "if audit can't fix this, can `classify` make progress on
 * it?" Required so `deriveProjectState` can distinguish 'classify can
 * relocate this' from 'unfixable, no remedy' by construction (#379). A
 * `fixable: true` rule splits further on `interactive` — the `interactive:
 * true` arm additionally requires `describeDecisions` (the pre-pass hook),
 * and the `interactive: false` arm forbids it. Forgetting
 * `describeDecisions` on a new interactive rule, or `classifyRelocatable`
 * on a new unfixable rule, is a compile error — the same shape that
 * prevents silently-unfixable rules from shipping also prevents silently-
 * unresolvable ones from masquerading as classify work.
 */
export type DriftRule =
  | {
      id: DriftRuleId;
      severity: Severity;
      description: string;
      detect: (input: DriftRuleInput) => DriftFinding | null;
      fixable: false;
      /**
       * True when `classify` is the owning remedy for findings of this rule
       * (it relocates the file, flips meta.kind, or proposes meta.role —
       * MISPLACED, MISCLASSIFIED-*, SMART-PART-NO-ROLE). False when no
       * shipped step in the canonical loop can clear the finding —
       * PATTERN-NO-SLOTS, PATTERN-IMPORTS-PATTERN, ROLE-NO-CONTRACT — and
       * the consumer must hand-edit, register an exception, or wait for the
       * pack to ship support. Read by `deriveProjectState` to keep heal's
       * convergence honest: classify-relocatable findings drive
       * `classifyNeeded`; truly-unresolvable findings drive the
       * `unresolvableFindings` signal instead so heal cannot silently
       * declare convergence with real ERROR findings outstanding.
       */
      classifyRelocatable: boolean;
    }
  | {
      id: DriftRuleId;
      severity: Severity;
      description: string;
      detect: (input: DriftRuleInput) => DriftFinding | null;
      fixable: true;
      fix: DriftFixer;
      priority: number;
      interactive: false;
    }
  | {
      id: DriftRuleId;
      severity: Severity;
      description: string;
      detect: (input: DriftRuleInput) => DriftFinding | null;
      fixable: true;
      fix: DriftFixer;
      priority: number;
      interactive: true;
      describeDecisions: DescribeDecisions;
    };
