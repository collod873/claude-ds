/**
 * Read source from `start` until a statement boundary — either a top-level
 * `;`, or a newline followed by what looks like the start of a new
 * statement (export/import/const/let/var/function/class/type/interface/`//`).
 *
 * Used by the ds-imports-feature fixer (to lift a definition out of the
 * source domain file) and the raw-primitive fixer (to extract an inline
 * component's surrounding local declarations).
 */
export function extractUntilStatement(source: string, start: number): string {
	let depth = 0;
	let inString: string | null = null;
	for (let i = start; i < source.length; i++) {
		const c = source[i];
		if (inString) {
			if (c === inString && source[i - 1] !== "\\") inString = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			inString = c;
			continue;
		}
		if (c === "{" || c === "(" || c === "[") depth++;
		if (c === "}" || c === ")" || c === "]") depth--;
		if (depth === 0 && c === ";") return source.slice(start, i + 1);
		if (depth === 0 && c === "\n" && i > start + 10) {
			const remaining = source.slice(i + 1).trimStart();
			if (/^(export|import|const|let|var|function|class|type|interface|\/\/)/.test(remaining)) {
				return source.slice(start, i);
			}
		}
	}
	return source.slice(start);
}
