import { type DriftRuleId, ruleSeverity } from "../drift/index.js";
import { type IntegrityRuleId, integrityRuleSeverity } from "../integrity/index.js";

export interface FindingForFormat {
	ruleId: string;
	file: string;
	message: string;
}

export interface FormatFindingsOptions {
	/**
	 * Resolve the severity prefix for rule ids that live outside the
	 * drift/integrity tables — advisory `BYPASS-` ids resolve to `"info"`
	 * (issue #586). When absent (the drift/integrity callers), the tables
	 * decide, so those paths are unchanged.
	 */
	severityFor?: (ruleId: string) => "error" | "warning" | "info";
	/**
	 * A per-rule note appended to the header line — the mechanism/dismiss
	 * sentence stated *once per rule* for advisory blocks (issue #586), so the
	 * ~40-word remediation no longer repeats once per finding.
	 */
	noteFor?: (ruleId: string) => string | undefined;
}

/**
 * Group findings by ruleId and render them as the audit's grouped output:
 * one header line per rule (with a severity prefix and finding count) and
 * one indented line per finding. Pure — no I/O.
 *
 * Header severity uses the integrity severity table for INTEGRITY-* rules
 * and the drift severity table for everything else, unless `severityFor`
 * overrides it. This is the *single* rendering path for grouped findings —
 * drift/integrity blocks and the advisory structural-bypass block both flow
 * through it (issue #586); advisory callers pass `severityFor`/`noteFor` to
 * supply their INFO prefix and once-per-rule mechanism sentence.
 */
export function formatFindings(
	findings: FindingForFormat[],
	options: FormatFindingsOptions = {},
): string[] {
	const byRule = new Map<string, FindingForFormat[]>();
	for (const f of findings) {
		const group = byRule.get(f.ruleId);
		if (group) group.push(f);
		else byRule.set(f.ruleId, [f]);
	}

	const lines: string[] = [];
	for (const [ruleId, ruleFindings] of byRule) {
		const severity =
			options.severityFor?.(ruleId) ??
			(ruleId.startsWith("INTEGRITY-")
				? integrityRuleSeverity(ruleId as IntegrityRuleId)
				: ruleSeverity(ruleId as DriftRuleId));
		const prefix = severity === "error" ? "ERROR" : severity === "warning" ? "WARNING" : "INFO";
		const noun = ruleFindings.length === 1 ? "finding" : "findings";
		const note = options.noteFor?.(ruleId);
		lines.push(
			`${prefix}  [${ruleId}] (${ruleFindings.length} ${noun})${note ? ` — ${note}` : ""}`,
		);
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
	const { scaffoldPresent, scaffoldTotal, reconciledCount, fixedCount, warningCount, errorCount } =
		opts;
	const parts: string[] = [];
	let scaffold = `Managed files: ${scaffoldPresent}/${scaffoldTotal}`;
	if (scaffoldPresent === scaffoldTotal) scaffold += " ✓";
	parts.push(scaffold);
	if (reconciledCount > 0) parts.push(`Reconciled: ${reconciledCount}`);
	if (fixedCount > 0) parts.push(`Fixed: ${fixedCount}`);
	if (warningCount > 0) parts.push(`Warnings: ${warningCount}`);
	if (errorCount > 0) parts.push(`Errors: ${errorCount}`);
	return parts.join(" | ");
}
