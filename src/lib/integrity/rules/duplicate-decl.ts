import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change } from "../../operation.js";
import type { ProjectContext } from "../../project.js";
import { dedupeDuplicateFns } from "../dedupe-decls.js";
import { analyzeResolution } from "../resolve-symbols.js";
import type { IntegrityFinding, IntegrityFixResult, IntegrityRule } from "../rule.js";

/**
 * Fires when a file declares the same top-level function twice with a body —
 * `TS2393 Duplicate function implementation`, the `the name 'WeekGrid' is
 * defined multiple times` half of the #259 corruption signature. A buggy
 * extraction that duplicated a component body produces exactly this, and it is
 * invisible to every convention rule because the file still parses.
 *
 * Overload signatures (several declarations, one body) are not flagged — only
 * genuine duplicate *implementations*. Detection-only and **blocking**: the
 * file cannot compile, so drift is skipped on it and audit cannot call it clean.
 */
function detect(file: string, source: string): IntegrityFinding[] {
	const { duplicateFns } = analyzeResolution(source, file);
	if (duplicateFns.length === 0) return [];
	return [
		{
			ruleId: "INTEGRITY-DUPLICATE-DECL",
			file,
			message: `Declares ${duplicateFns.length} top-level function(s) more than once: ${duplicateFns.join(", ")}`,
		},
	];
}

/**
 * Drop redundant top-level function implementations, keeping one — but only
 * when the duplicates are textually identical. Differing implementations are
 * left flagged (choosing a winner would be a guess). The Crewops corruption is
 * a component body duplicated verbatim, which this heals; anything ambiguous
 * stays a finding (#260).
 */
async function fix(finding: IntegrityFinding, ctx: ProjectContext): Promise<IntegrityFixResult> {
	const cwd = ctx.cwd;
	let source: string;
	try {
		source = await readFile(join(cwd, finding.file), "utf8");
	} catch {
		return { finding, fixed: false, message: `Could not read ${finding.file}`, changes: [] };
	}

	const {
		source: deduped,
		deduped: didDedupe,
		remaining,
	} = dedupeDuplicateFns(source, finding.file);

	if (!didDedupe) {
		return {
			finding,
			fixed: false,
			message: `Duplicate implementations of ${remaining.join(", ")} differ — left flagged, not auto-merged`,
			changes: [],
		};
	}

	const changes: Change[] = [
		{ kind: "write", path: finding.file, before: Buffer.from(source), after: Buffer.from(deduped) },
	];
	const message =
		remaining.length > 0
			? `Deduped identical functions in ${finding.file}; ${remaining.length} differing duplicate(s) left flagged: ${remaining.join(", ")}`
			: `Deduped redundant function declaration(s) in ${finding.file}`;
	return { finding, fixed: true, message, changes };
}

export const duplicateDeclRule: IntegrityRule = {
	id: "INTEGRITY-DUPLICATE-DECL",
	severity: "error",
	description:
		"File declares the same top-level function implementation twice — cannot compile (TS2393)",
	detect,
	fixable: true,
	fix,
};
