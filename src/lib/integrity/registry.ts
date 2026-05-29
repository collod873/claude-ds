import {
  evalOrphanedFrom,
  evalUnparseable,
  evalUnresolvableImport,
  type IntegrityContext,
  type IntegrityFinding,
  type IntegrityRuleId,
} from "../integrity-rules.js";
import { restoreFromHead } from "./restore-from-head.js";
import type { IntegrityRule } from "./rule.js";

const unparseableRule: IntegrityRule = {
  id: "INTEGRITY-UNPARSEABLE",
  severity: "error",
  description:
    "File cannot be parsed as TypeScript/JSX — may have broken syntax from a fixer bug or manual edit",
  detect: (file: string, source: string): IntegrityFinding[] => {
    const r = evalUnparseable(file, source);
    return r ? [r] : [];
  },
  fixable: true,
  fix: (finding, cwd) => restoreFromHead(finding, cwd),
};

const orphanedFromRule: IntegrityRule = {
  id: "INTEGRITY-ORPHANED-FROM",
  severity: "error",
  description:
    "File contains '} from' without a matching import opener — likely a fixer stripped the import declaration",
  detect: (file: string, source: string): IntegrityFinding[] => {
    const r = evalOrphanedFrom(file, source);
    return r ? [r] : [];
  },
  fixable: true,
  fix: (finding, cwd) => restoreFromHead(finding, cwd),
};

const unresolvableImportRule: IntegrityRule = {
  id: "INTEGRITY-UNRESOLVABLE-IMPORT",
  severity: "error",
  description:
    "File imports a path that does not resolve to an existing file or directory index",
  blocking: false,
  detect: (
    file: string,
    source: string,
    ctx?: IntegrityContext,
  ): IntegrityFinding[] | Promise<IntegrityFinding[]> => {
    if (!ctx) return [];
    return evalUnresolvableImport(file, source, ctx);
  },
  fixable: false,
};

/**
 * The integrity-rule registry indexed by id. Declared as
 * `Record<IntegrityRuleId, IntegrityRule>` so the compiler enforces totality —
 * adding a new id to the `IntegrityRuleId` union without adding the matching
 * rule here fails to build. Mirrors `DRIFT_RULES_BY_ID`'s seam exactly.
 *
 * `evaluateIntegrity`, `integrityRuleDescription`, `integrityRuleSeverity`,
 * `allIntegrityRuleIds`, `isIntegrityFixable`, and `integrityFixerAsOperation`
 * all route through this record. Subsequent slices reshape the file layout
 * (one file per rule) and extract the ADR-0014 fixer-output validation gate.
 */
export const INTEGRITY_RULES_BY_ID: Record<IntegrityRuleId, IntegrityRule> = {
  "INTEGRITY-UNPARSEABLE": unparseableRule,
  "INTEGRITY-ORPHANED-FROM": orphanedFromRule,
  "INTEGRITY-UNRESOLVABLE-IMPORT": unresolvableImportRule,
};

/**
 * The integrity-rule registry as an ordered array. Derived from
 * `INTEGRITY_RULES_BY_ID` so the typed record's totality check propagates
 * here — the array can't silently miss a rule. Order is the canonical
 * evaluation order, matching the order today's `evaluateIntegrity` invokes
 * its eval* functions.
 */
export const INTEGRITY_RULES: readonly IntegrityRule[] = Object.values(INTEGRITY_RULES_BY_ID);
