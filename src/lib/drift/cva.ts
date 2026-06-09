const PSEUDO_STATE_AXES = new Set([
	"hover",
	"focus",
	"active",
	"disabled",
	"checked",
	"selected",
	"visited",
	"pressed",
	"expanded",
	"visible",
	"open",
	"closed",
	"dark",
	"light",
	"focusVisible",
	"focusWithin",
]);

/**
 * Extract CVA variant axis names and their values from source.
 * Matches the variants object inside a cva() call.
 * Filters out pseudo-state axes (hover, focus, active, etc.) that are
 * CSS state selectors, not settable props.
 *
 * Shared by the CVA-unrendered rule (detect + fix) and the raw-primitive
 * fixer (which parses the atom's own source to infer a variant prop).
 */
export function parseCvaVariants(source: string): Record<string, string[]> | null {
	if (!source.includes("cva(")) return null;

	const broadMatch = source.match(
		/variants\s*:\s*\{([\s\S]*?)\}\s*(?:,\s*(?:defaultVariants|compoundVariants)|,?\s*\}\s*\))/,
	);
	if (!broadMatch) return null;

	const varBlock = broadMatch[1];
	const result: Record<string, string[]> = {};

	// Brace-balanced extraction of top-level axis blocks
	const axisStartRe = /(\w+)\s*:\s*\{/g;
	let am: RegExpExecArray | null;
	while ((am = axisStartRe.exec(varBlock)) !== null) {
		const axisName = am[1];
		if (PSEUDO_STATE_AXES.has(axisName)) continue;

		// Walk forward from the opening { to find the balanced closing }
		let depth = 1;
		let i = am.index + am[0].length;
		while (i < varBlock.length && depth > 0) {
			if (varBlock[i] === "{") depth++;
			else if (varBlock[i] === "}") depth--;
			i++;
		}
		if (depth !== 0) continue;

		const axisBody = varBlock.slice(am.index + am[0].length, i - 1);

		// Extract only top-level keys (depth-0 `word:` patterns, outside strings)
		const valueKeySet = new Set<string>();
		const keyRe = /(\w+)\s*:/g;
		let km: RegExpExecArray | null;
		while ((km = keyRe.exec(axisBody)) !== null) {
			const prefix = axisBody.slice(0, km.index);
			let d = 0;
			let inStr: string | null = null;
			for (const ch of prefix) {
				if (inStr) {
					if (ch === inStr) inStr = null;
					continue;
				}
				if (ch === '"' || ch === "'" || ch === "`") {
					inStr = ch;
					continue;
				}
				if (ch === "{" || ch === "[" || ch === "(") d++;
				else if (ch === "}" || ch === "]" || ch === ")") d--;
			}
			if (d === 0 && !inStr) valueKeySet.add(km[1]);
		}
		if (valueKeySet.size > 0) {
			result[axisName] = [...valueKeySet];
		}
	}

	return Object.keys(result).length > 0 ? result : null;
}
