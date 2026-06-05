import type { IntegrityFinding, IntegrityRule } from "../rule.js";
import { analyzeResolution } from "../resolve-symbols.js";

/**
 * Fires when a tier file references value-position identifiers it never binds —
 * no import, no local declaration, no parameter — and that are not runtime
 * globals. This is the corruption class that survived a full brownfield heal in
 * #259: atoms whose import block was stripped (`cn`, `Button`, `format`,
 * `startOfDay`) still parse and still satisfy every convention rule, so audit
 * scored them `clean` while `tsc` reported `TS2304 Cannot find name`.
 *
 * Detection-only and **blocking**: a file that cannot resolve its own symbols
 * cannot compile, so it is excluded from downstream drift evaluation and, being
 * non-fixable, keeps `audit` from reporting a clean fixed point. Re-deriving the
 * missing import closure is a separate, riskier repair tracked for follow-up;
 * the gate is the headline fix.
 */
function detect(file: string, source: string): IntegrityFinding[] {
  const { unresolved } = analyzeResolution(source, file);
  if (unresolved.length === 0) return [];
  return [
    {
      ruleId: "INTEGRITY-UNRESOLVED-SYMBOL",
      file,
      message: `References ${unresolved.length} unbound symbol(s) (no import or local declaration): ${unresolved.join(", ")}`,
    },
  ];
}

export const unresolvedSymbolRule: IntegrityRule = {
  id: "INTEGRITY-UNRESOLVED-SYMBOL",
  severity: "error",
  description:
    "File references value identifiers it never imports or declares — cannot compile (TS2304/TS2686)",
  detect,
  fixable: false,
};
