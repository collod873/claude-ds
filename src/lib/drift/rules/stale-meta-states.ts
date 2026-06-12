import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { adrUrl } from "../../adr-citation.js";
import type { Change } from "../../operation.js";
import type { ProjectContext } from "../../project.js";

import type { DriftFinding, DriftRule, DriftRuleInput, FixResult } from "../rule.js";

const META_STATES_RE = /\bstates\s*:\s*\{/;

/** DRIFT-STALE-META-STATES: meta contains retired `states` field (ADR-0007). */
function detect(input: DriftRuleInput): DriftFinding | null {
	const { file, locationTier, source } = input;
	if (locationTier === null) return null;
	if (source === undefined) return null;
	if (!source.includes("export const meta")) return null;
	const metaMatch = /export\s+const\s+meta[\s:=]/.exec(source);
	if (!metaMatch) return null;
	const afterMeta = source.slice(metaMatch.index);
	if (!META_STATES_RE.test(afterMeta)) return null;
	return {
		ruleId: "DRIFT-STALE-META-STATES",
		file,
		message: `meta contains retired \`states\` field — remove per ${adrUrl("states-contract-retired")}`,
	};
}

// --- DRIFT-STALE-META-STATES fixer ---

function stripMetaStates(source: string): string {
	const re = /\bstates\s*:\s*/;
	const match = re.exec(source);
	if (!match) return source;

	const valueStart = match.index + match[0].length;
	if (valueStart >= source.length) return source;

	const firstChar = source[valueStart];

	let endIdx = -1;
	if (firstChar === "{" || firstChar === "[") {
		const open = firstChar;
		const close = open === "{" ? "}" : "]";
		let depth = 0;
		let i = valueStart;
		while (i < source.length) {
			const ch = source[i];
			if (ch === "/" && source[i + 1] === "/") {
				// Line comment: skip to newline so apostrophes/backticks inside
				// comment prose aren't mistaken for string delimiters.
				i += 2;
				while (i < source.length && source[i] !== "\n") i++;
				continue;
			} else if (ch === "/" && source[i + 1] === "*") {
				// Block comment: skip to the closing */.
				i += 2;
				while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
				i += 2;
				continue;
			} else if (ch === open) {
				depth++;
			} else if (ch === close) {
				depth--;
				if (depth === 0) {
					endIdx = i;
					break;
				}
			} else if (ch === '"' || ch === "'" || ch === "`") {
				const quote = ch;
				i++;
				while (i < source.length) {
					if (source[i] === "\\") {
						i += 2;
						continue;
					}
					if (source[i] === quote) break;
					i++;
				}
			}
			i++;
		}
		if (endIdx === -1) return source;
		endIdx += 1;
	} else if (firstChar === '"' || firstChar === "'" || firstChar === "`") {
		let i = valueStart + 1;
		while (i < source.length) {
			if (source[i] === "\\") {
				i += 2;
				continue;
			}
			if (source[i] === firstChar) {
				endIdx = i + 1;
				break;
			}
			i++;
		}
		if (endIdx === -1) return source;
	} else {
		let i = valueStart;
		while (i < source.length && source[i] !== "," && source[i] !== "\n" && source[i] !== "}") i++;
		endIdx = i;
	}

	let start = match.index;
	while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
	if (start > 0 && source[start - 1] === "\n") start--;

	let end = endIdx;
	while (
		end < source.length &&
		(source[end] === "," || source[end] === " " || source[end] === "\t")
	)
		end++;
	if (end < source.length && source[end] === "\n") end++;

	return source.slice(0, start) + source.slice(end);
}

async function fix(finding: DriftFinding, ctx: ProjectContext): Promise<FixResult> {
	const absPath = join(ctx.cwd, finding.file);
	let source: string;
	try {
		source = await readFile(absPath, "utf8");
	} catch {
		return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
	}

	const result = stripMetaStates(source);
	if (result === source) {
		return {
			finding,
			fixed: false,
			message: `no states field found in ${finding.file}`,
			changes: [],
		};
	}

	const changes: Change[] = [
		{
			kind: "write",
			path: finding.file,
			before: Buffer.from(source),
			after: Buffer.from(result),
		},
	];

	return {
		finding,
		fixed: true,
		message: `stripped retired meta.states from ${finding.file}`,
		changes,
	};
}

export const staleMetaStatesRule: DriftRule = {
	id: "DRIFT-STALE-META-STATES",
	severity: "error",
	description: "meta object contains a retired `states` field (ADR-0007) — strip it",
	detect,
	fixable: true,
	fix,
	priority: 0,
	interactive: false,
};
