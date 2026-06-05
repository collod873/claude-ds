import type { IntegrityRule, IntegrityRuleId } from "./rule.js";
import { duplicateDeclRule } from "./rules/duplicate-decl.js";
import { orphanedFromRule } from "./rules/orphaned-from.js";
import { unparseableRule } from "./rules/unparseable.js";
import { unresolvableImportRule } from "./rules/unresolvable-import.js";
import { unresolvedSymbolRule } from "./rules/unresolved-symbol.js";

/**
 * The integrity-rule registry indexed by id. Declared as
 * `Record<IntegrityRuleId, IntegrityRule>` so the compiler enforces totality —
 * adding a new id to the `IntegrityRuleId` union without adding the matching
 * rule here fails to build. Mirrors `DRIFT_RULES_BY_ID`'s seam exactly.
 *
 * `evaluateIntegrity`, `integrityRuleDescription`, `integrityRuleSeverity`,
 * `allIntegrityRuleIds`, `isIntegrityFixable`, and `integrityFixerAsOperation`
 * all route through this record.
 */
export const INTEGRITY_RULES_BY_ID: Record<IntegrityRuleId, IntegrityRule> = {
  "INTEGRITY-UNPARSEABLE": unparseableRule,
  "INTEGRITY-ORPHANED-FROM": orphanedFromRule,
  "INTEGRITY-UNRESOLVABLE-IMPORT": unresolvableImportRule,
  "INTEGRITY-UNRESOLVED-SYMBOL": unresolvedSymbolRule,
  "INTEGRITY-DUPLICATE-DECL": duplicateDeclRule,
};

/**
 * The integrity-rule registry as an ordered array. Derived from
 * `INTEGRITY_RULES_BY_ID` so the typed record's totality check propagates
 * here — the array can't silently miss a rule. Order is the canonical
 * evaluation order, matching the order today's `evaluateIntegrity` invokes
 * its rules.
 */
export const INTEGRITY_RULES: readonly IntegrityRule[] = Object.values(INTEGRITY_RULES_BY_ID);
