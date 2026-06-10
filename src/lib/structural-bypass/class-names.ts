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
 * Two shapes yield nothing, by design:
 *   - `className={someVar}` (bare identifier, no literal) — we never resolve
 *     variables; a fully dynamic className is invisible to a static signature.
 *   - `className={cn("rounded-lg …")}` / `clsx(…)` and other helper calls —
 *     the literals live *inside* an expression, not as the attribute value,
 *     and this extractor only reads the direct attribute value. This is a
 *     known recall gap for the shadcn `cn()` idiom (see ADR-0026 follow-up):
 *     v1 catches the direct-literal cases; widening to helper-call literals
 *     is an evidence-driven, ADR-amended extension, not a silent change here.
 *
 * The over-flag bias is therefore spent on the direct-literal cases only.
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
