import ts from "typescript";
import { restoreFromHead } from "../restore-from-head.js";
import type { IntegrityFinding, IntegrityRule } from "../rule.js";

function detect(file: string, source: string): IntegrityFinding[] {
	if (source.trim() === "") return [];

	const sf = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);

	const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
	if (!diagnostics || diagnostics.length === 0) return [];

	return [
		{
			ruleId: "INTEGRITY-UNPARSEABLE",
			file,
			message: `File has syntax errors and cannot be parsed (${diagnostics.length} parse error${diagnostics.length === 1 ? "" : "s"})`,
		},
	];
}

export const unparseableRule: IntegrityRule = {
	id: "INTEGRITY-UNPARSEABLE",
	severity: "error",
	description:
		"File cannot be parsed as TypeScript/JSX — may have broken syntax from a fixer bug or manual edit",
	detect,
	fixable: true,
	fix: (finding, ctx) => restoreFromHead(finding, ctx),
};
