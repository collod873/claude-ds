import type { Severity } from "../severity.js";
import type {
  IntegrityContext,
  IntegrityFinding,
  IntegrityRuleId,
} from "../integrity-rules.js";
import type { IntegrityFixResult } from "../integrity-fixers.js";

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
 * need the project `IntegrityContext` (cwd, aliases, tsconfig paths). Rules
 * that don't need `ctx` simply ignore the third arg.
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
        ctx?: IntegrityContext,
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
        ctx?: IntegrityContext,
      ) => IntegrityFinding[] | Promise<IntegrityFinding[]>;
      fixable: true;
      fix: (finding: IntegrityFinding, cwd: string) => Promise<IntegrityFixResult>;
    };
