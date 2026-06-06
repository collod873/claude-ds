import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change } from "../../operation.js";
import type { ProjectContext } from "../../project.js";
import type { IntegrityFinding, IntegrityFixResult, IntegrityRule } from "../rule.js";
import { analyzeResolution } from "../resolve-symbols.js";
import { repairUnresolvedSymbols } from "../repair-symbols.js";
import { buildRepairEnv } from "../repair-env.js";

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

/**
 * Re-derive the missing import closure, adding an import only for each unbound
 * symbol whose origin is *proven* (a specifier already in use across the
 * consumer's import graph). Symbols with no provable — or an ambiguous — source
 * are left untouched so the finding persists: honest partial repair, never a
 * guess that could compile-then-break a consumer (#260).
 */
async function fix(finding: IntegrityFinding, ctx: ProjectContext): Promise<IntegrityFixResult> {
  const cwd = ctx.cwd;
  let source: string;
  try {
    source = await readFile(join(cwd, finding.file), "utf8");
  } catch {
    return { finding, fixed: false, message: `Could not read ${finding.file}`, changes: [] };
  }

  const env = await buildRepairEnv(ctx, finding.file);
  const { source: repaired, repaired: didRepair, remaining } = repairUnresolvedSymbols(
    source,
    finding.file,
    env,
  );

  if (!didRepair) {
    return {
      finding,
      fixed: false,
      message: `No provable import source for ${remaining.join(", ")} — left flagged, not guessed`,
      changes: [],
    };
  }

  const changes: Change[] = [
    { kind: "write", path: finding.file, before: Buffer.from(source), after: Buffer.from(repaired) },
  ];
  const message =
    remaining.length > 0
      ? `Re-derived imports for ${finding.file}; ${remaining.length} symbol(s) still unprovable: ${remaining.join(", ")}`
      : `Re-derived missing import closure for ${finding.file}`;
  return { finding, fixed: true, message, changes };
}

export const unresolvedSymbolRule: IntegrityRule = {
  id: "INTEGRITY-UNRESOLVED-SYMBOL",
  severity: "error",
  description:
    "File references value identifiers it never imports or declares — cannot compile (TS2304/TS2686)",
  detect,
  fixable: true,
  fix,
};
