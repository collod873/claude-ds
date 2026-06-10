/**
 * Shared className extraction for the structural-bypass signatures (ADR-0026).
 *
 * The Card and Badge signatures both key on Tailwind utility combinations
 * inside `className` attributes; this is the one place that knows how to pull
 * those literals out of source. Pure — reads the string, returns the matches.
 *
 * Handles the three spellings consumers actually write:
 *   - `className="rounded-lg border bg-card"`
 *   - `className='rounded-full px-2'`
 *   - `` className={`rounded-lg ${maybe} border`} `` (template literal)
 *
 * A `className={someVar}` (bare identifier, no literal) yields nothing — we
 * only inspect literal utility text, never resolve variables. That is the
 * intended floor: a fully dynamic className is invisible to a static
 * signature, and the over-flag bias is spent on the literal cases that
 * dominate real hand-rolls.
 */

export interface ClassNameMatch {
	/** The literal utility text, e.g. "rounded-lg border bg-card". */
	value: string;
	/** 1-based line of the className attribute. */
	line: number;
}

const CLASSNAME_RE = /className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;

export function extractClassNames(source: string): ClassNameMatch[] {
	const matches: ClassNameMatch[] = [];
	for (const m of source.matchAll(CLASSNAME_RE)) {
		const value = m[1] ?? m[2] ?? m[3] ?? "";
		if (!value) continue;
		const line = source.slice(0, m.index).split("\n").length;
		matches.push({ value, line });
	}
	return matches;
}

/** True when every token regex matches somewhere in the className value. */
export function hasAllTokens(value: string, tokens: readonly RegExp[]): boolean {
	return tokens.every((t) => t.test(value));
}
