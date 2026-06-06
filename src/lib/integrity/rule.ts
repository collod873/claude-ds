import type { Change } from "../operation.js";
import type { ProjectContext } from "../project.js";
import type { Severity } from "../severity.js";

/**
 * Stable public vocabulary for integrity rule IDs (ADR-0014).
 * Entries are part of the pack's public surface (referenced by
 * `exceptions.json` forever); do not remove or rename.
 */
export type IntegrityRuleId =
  | "INTEGRITY-UNPARSEABLE"
  | "INTEGRITY-ORPHANED-FROM"
  | "INTEGRITY-UNRESOLVABLE-IMPORT"
  | "INTEGRITY-UNRESOLVED-SYMBOL"
  | "INTEGRITY-DUPLICATE-DECL";

export interface IntegrityFinding {
  ruleId: IntegrityRuleId;
  file: string;
  message: string;
}

export interface IntegrityFixResult {
  finding: IntegrityFinding;
  fixed: boolean;
  message: string;
  changes: Change[];
}

/**
 * One integrity rule, co-locating its detect + (optional) fix + metadata.
 *
 * Discriminated on `fixable`: a `fixable: true` rule MUST also declare `fix`.
 * A `fixable: false` rule MUST NOT declare it. This mirrors `DriftRule`'s
 * seam — the compile-time gate that prevents a silently-unfixable rule from
 * shipping. The drift type also carries `priority` and `interactive`;
 * integrity has neither (integrity fixers don't prompt and run as one
 * ahead-of-drift phase rather than priority-sorted).
 *
 * `blocking` defaults to `true`. Set to `false` only when an INTEGRITY-* rule
 * must not gate downstream drift evaluation — currently
 * `INTEGRITY-UNRESOLVABLE-IMPORT`. The current blocking/non-blocking split in
 * `reports/drift-integrity-scan.ts` derives from this field.
 *
 * `detect` returns `IntegrityFinding[] | Promise<IntegrityFinding[]>` and
 * takes `(file, source, ctx?)`: a single rule may emit multiple findings on
 * one file (UNRESOLVABLE-IMPORT does, one per unresolved import path) and may
 * need the `ProjectContext` (cwd, `ctx.auditConfig.dsAliases`,
 * `ctx.auditConfig.tsconfigPaths`). Rules that don't need `ctx` simply ignore
 * the third arg. PRD #266 Phase B: `IntegrityContext` is deleted in favor of
 * `ProjectContext`, so integrity and drift share one audit-config source.
 */
export type IntegrityRule =
  | {
      id: IntegrityRuleId;
      severity: Severity;
      description: string;
      blocking?: boolean;
      detect: (
        file: string,
        source: string,
        ctx?: ProjectContext,
      ) => IntegrityFinding[] | Promise<IntegrityFinding[]>;
      fixable: false;
    }
  | {
      id: IntegrityRuleId;
      severity: Severity;
      description: string;
      blocking?: boolean;
      detect: (
        file: string,
        source: string,
        ctx?: ProjectContext,
      ) => IntegrityFinding[] | Promise<IntegrityFinding[]>;
      fixable: true;
      fix: (finding: IntegrityFinding, ctx: ProjectContext) => Promise<IntegrityFixResult>;
    };
