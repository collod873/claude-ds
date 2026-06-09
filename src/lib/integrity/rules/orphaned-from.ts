import { restoreFromHead } from "../restore-from-head.js";
import type { IntegrityFinding, IntegrityRule } from "../rule.js";

function detect(file: string, source: string): IntegrityFinding[] {
	const lines = source.split("\n");
	const orphanedLines: number[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!/}\s+from\s+["']/.test(line)) continue;
		if (/^(?:import|export)\s/.test(line)) continue;

		let hasOpener = false;
		for (let j = i - 1; j >= 0; j--) {
			const prev = lines[j].trim();
			if (/^(?:import|export)\s*\{/.test(prev)) {
				hasOpener = true;
				break;
			}
			if (prev === "" || /^(?:import|export)\s/.test(prev) || /[;)]$/.test(prev)) break;
		}
		if (!hasOpener) orphanedLines.push(i + 1);
	}

	if (orphanedLines.length === 0) return [];
	return [
		{
			ruleId: "INTEGRITY-ORPHANED-FROM",
			file,
			message: `Orphaned '} from' at line${orphanedLines.length > 1 ? "s" : ""} ${orphanedLines.join(", ")} — missing import opener`,
		},
	];
}

export const orphanedFromRule: IntegrityRule = {
	id: "INTEGRITY-ORPHANED-FROM",
	severity: "error",
	description:
		"File contains '} from' without a matching import opener — likely a fixer stripped the import declaration",
	detect,
	fixable: true,
	fix: (finding, ctx) => restoreFromHead(finding, ctx),
};
