/**
 * `mergeMetaKind` — the A1 deep module (PRD #407 / issue #409).
 *
 * Locates an existing `export const meta` declaration (typed `: Meta`,
 * `as const`, single- or multi-line) and injects `kind: "<tier>" as const`
 * into the existing object literal when `kind` is absent — preserving the
 * existing `examples` / `role` fields and the original formatting. Only
 * emits a fresh declaration when the file genuinely carries no
 * `export const meta`.
 *
 * Hard guarantee: a single input never yields two top-level
 * `export const meta` in the output. That is the property the previous
 * append-only fixer broke and the property a Crewops-shaped consumer
 * tree silently depends on.
 *
 * Out of scope: a pre-existing meta whose `kind` *conflicts* with the
 * tier. That is a different rule (kind-vs-location mismatch) and is
 * handled elsewhere — this module only backfills a *missing* `kind`.
 */
import type { Tier } from "../classifier.js";
import { findMetaBody, hasTopLevelKey } from "../meta-source.js";

/**
 * Merge `kind: "<tier>" as const` into the existing meta declaration in
 * `source`, or emit a fresh one if no `export const meta` is present.
 *
 * Pure function — no I/O. Locates the meta object via the shared
 * `meta-source` parser, the same one the drift checker reads through, so the
 * checker and this fixer can never disagree about whether `kind` is present.
 */
export function mergeMetaKind(source: string, tier: Tier): string {
	const meta = findMetaBody(source);
	if (!meta) return appendFreshMeta(source, tier);

	const { openIdx: openBraceIdx, closeIdx: closeBraceIdx, body } = meta;
	// Malformed source — bail rather than risk producing nonsense.
	if (closeBraceIdx === -1) return source;

	if (hasTopLevelKey(body, "kind")) return source;

	const before = source.slice(0, openBraceIdx + 1);
	const after = source.slice(closeBraceIdx);

	// Empty object → render the kind compactly inside the existing `{}`.
	if (body.trim() === "") {
		return before + ` kind: "${tier}" as const ` + after;
	}

	if (body.includes("\n")) {
		// Multiline: match the indent of the first existing field.
		const indent = detectFieldIndent(body);
		const insertion = `\n${indent}kind: "${tier}" as const,`;
		return before + insertion + body + after;
	}

	// Single-line: drop the kind in just after the opening brace, normalising
	// the gap between `{` and the first field to a single space so the output
	// reads cleanly regardless of the input's leading whitespace.
	const trimmedBody = body.replace(/^[ \t]+/, "");
	return before + ` kind: "${tier}" as const, ` + trimmedBody + after;
}

function appendFreshMeta(source: string, tier: Tier): string {
	const metaExport = `\nexport const meta = { kind: "${tier}" as const, examples: [] };\n`;
	return source.trimEnd() + "\n" + metaExport;
}

/**
 * Pick an indent for the injected `kind:` line by sampling the first
 * non-blank line inside the existing object body. Falls back to two spaces
 * when the body has no precedent (e.g. only a trailing comment).
 */
function detectFieldIndent(body: string): string {
	const m = body.match(/\n([ \t]+)\S/);
	return m ? m[1] : "  ";
}
