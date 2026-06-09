/**
 * `meta-source` — the single brace-aware reader for an
 * `export const meta = { … }` declaration's source text.
 *
 * One module so the drift checker, the gate-preview counter, and the fixer
 * are *physically incapable* of disagreeing about what a meta block declares.
 *
 * Root cause this replaces: two independent readers existed. The detector and
 * the "missing meta.kind" counter used a naive regex
 * (`/\bmeta\s*=\s*\{[^}]*\bkind:.../ `) whose `[^}]*` stopped at the first
 * nested `}` — so a meta whose `kind` sat *after* a nested brace
 * (`examples: [{…}]`, or fields ordered before `kind`) read as "missing",
 * while the brace-aware fixer (`mergeMetaKind`) correctly found it and no-op'd.
 * Same file, opposite verdicts → the `audit --fix` loop never converged.
 * Now both the readers and the fixer compose these primitives.
 */

/**
 * Locates `export const meta = {` — optionally typed (`: Meta`,
 * `: Meta<Props>`). Captures up to the opening `{`; the matching `}` is found
 * by walking balanced braces (see `findMatchingBrace`), never by regex.
 */
export const META_DECL_RE = /\bexport\s+const\s+meta\s*(?::\s*[^=]+?)?=\s*\{/;

export interface MetaBody {
	/** Index of the meta object's opening `{`. */
	openIdx: number;
	/** Index of the matching `}`, or -1 when the braces are unbalanced (malformed). */
	closeIdx: number;
	/** Text strictly between the braces; "" when malformed. */
	body: string;
}

/**
 * Locate the `export const meta` object body, or `null` when the file carries
 * no such declaration. When the declaration exists but its braces are
 * unbalanced, returns a `MetaBody` with `closeIdx === -1` and `body === ""` so
 * callers can distinguish "no meta" from "malformed meta".
 */
export function findMetaBody(source: string): MetaBody | null {
	const m = META_DECL_RE.exec(source);
	if (!m) return null;
	const openIdx = m.index + m[0].length - 1;
	const closeIdx = findMatchingBrace(source, openIdx);
	if (closeIdx === -1) return { openIdx, closeIdx, body: "" };
	return { openIdx, closeIdx, body: source.slice(openIdx + 1, closeIdx) };
}

/**
 * Walk from `openIdx` (which must point at `{`) and return the index of the
 * matching `}` — respecting nested braces, strings, template literals, and
 * comments. Returns `-1` when the source is unbalanced (malformed).
 */
export function findMatchingBrace(source: string, openIdx: number): number {
	let depth = 0;
	let inString: string | null = null;
	let inLineComment = false;
	let inBlockComment = false;
	for (let i = openIdx; i < source.length; i++) {
		const ch = source[i];
		const next = i + 1 < source.length ? source[i + 1] : "";
		if (inLineComment) {
			if (ch === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (ch === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inString) {
			if (ch === "\\") {
				i++; // skip the escaped char
				continue;
			}
			if (ch === inString) inString = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inString = ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Scan an object body for a top-level (depth 0) `key:` and return the index of
 * the first non-whitespace character of its value, or -1 if the key is absent
 * at top level. Respects nested objects/arrays/calls, strings, template
 * literals, and comments — so a `kind` token buried inside
 * `examples: [{ props: { kind: "x" } }]` is never mistaken for the field.
 *
 * Shared spine for `hasTopLevelKey` (presence) and `topLevelStringValue`
 * (value), so they can never drift apart.
 */
function topLevelKeyValueStart(body: string, key: string): number {
	let depth = 0;
	let inString: string | null = null;
	let inLineComment = false;
	let inBlockComment = false;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		const next = i + 1 < body.length ? body[i + 1] : "";
		if (inLineComment) {
			if (ch === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (ch === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inString) {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === inString) inString = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inString = ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}
		if (ch === "{" || ch === "[" || ch === "(") {
			depth++;
			continue;
		}
		if (ch === "}" || ch === "]" || ch === ")") {
			depth--;
			continue;
		}
		if (depth === 0 && /[A-Za-z_$]/.test(ch)) {
			let j = i;
			while (j < body.length && /[\w$]/.test(body[j])) j++;
			const ident = body.slice(i, j);
			if (ident === key) {
				let k = j;
				while (k < body.length && /\s/.test(body[k])) k++;
				if (body[k] === ":") {
					k++;
					while (k < body.length && /\s/.test(body[k])) k++;
					return k;
				}
			}
			i = j - 1; // -1 because the loop will i++ next
		}
	}
	return -1;
}

/** Does the object body declare `key:` at top level (depth 0)? */
export function hasTopLevelKey(body: string, key: string): boolean {
	return topLevelKeyValueStart(body, key) !== -1;
}

/**
 * The string-literal value of a top-level `key:` in the object body, or `null`
 * when the key is absent at top level or its value is not a string literal.
 * Unescapes the literal's contents (single, double, or backtick quoted).
 */
export function topLevelStringValue(body: string, key: string): string | null {
	const start = topLevelKeyValueStart(body, key);
	if (start === -1) return null;
	const quote = body[start];
	if (quote !== '"' && quote !== "'" && quote !== "`") return null;
	let value = "";
	for (let i = start + 1; i < body.length; i++) {
		const ch = body[i];
		if (ch === "\\") {
			value += body[i + 1] ?? "";
			i++;
			continue;
		}
		if (ch === quote) return value;
		value += ch;
	}
	return null; // unterminated literal — treat as absent
}
