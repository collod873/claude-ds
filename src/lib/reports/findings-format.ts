import { ruleSeverity, type DriftRuleId } from "../drift/index.js";
import { integrityRuleSeverity, type IntegrityRuleId } from "../integrity/index.js";

export interface FindingForFormat {
  ruleId: string;
  file: string;
  message: string;
}

/**
 * Group findings by ruleId and render them as the audit's grouped output:
 * one header line per rule (with a severity prefix and finding count) and
 * one indented line per finding. Pure — no I/O.
 *
 * Header severity uses the integrity severity table for INTEGRITY-* rules
 * and the drift severity table for everything else.
 */
export function formatFindings(findings: FindingForFormat[]): string[] {
  const byRule = new Map<string, FindingForFormat[]>();
  for (const f of findings) {
    const group = byRule.get(f.ruleId);
    if (group) group.push(f);
    else byRule.set(f.ruleId, [f]);
  }

  const lines: string[] = [];
  for (const [ruleId, ruleFindings] of byRule) {
    const severity = ruleId.startsWith("INTEGRITY-")
      ? integrityRuleSeverity(ruleId as IntegrityRuleId)
      : ruleSeverity(ruleId as DriftRuleId);
    const prefix = severity === "error" ? "ERROR" : severity === "warning" ? "WARNING" : "INFO";
    const noun = ruleFindings.length === 1 ? "finding" : "findings";
    lines.push(`${prefix}  [${ruleId}] (${ruleFindings.length} ${noun})`);
    for (const f of ruleFindings) {
      lines.push(`  ${f.file}: ${f.message}`);
    }
  }
  return lines;
}

/**
 * Render the audit's scorecard line. Always includes scaffold. Other segments
 * appear only when > 0. Pure — no I/O.
 */
export function formatScorecard(opts: {
  scaffoldPresent: number;
  scaffoldTotal: number;
  reconciledCount: number;
  fixedCount: number;
  warningCount: number;
  errorCount: number;
}): string {
  const { scaffoldPresent, scaffoldTotal, reconciledCount, fixedCount, warningCount, errorCount } = opts;
  const parts: string[] = [];
  let scaffold = `Scaffold: ${scaffoldPresent}/${scaffoldTotal}`;
  if (scaffoldPresent === scaffoldTotal) scaffold += " ✓";
  parts.push(scaffold);
  if (reconciledCount > 0) parts.push(`Reconciled: ${reconciledCount}`);
  if (fixedCount > 0) parts.push(`Fixed: ${fixedCount}`);
  if (warningCount > 0) parts.push(`Warnings: ${warningCount}`);
  if (errorCount > 0) parts.push(`Errors: ${errorCount}`);
  return parts.join(" | ");
}
