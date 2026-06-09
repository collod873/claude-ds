import ts from "typescript";

/**
 * Outcome of a duplicate-declaration dedup pass.
 *
 * `source` — the (possibly rewritten) file text; unchanged when nothing was
 * provably deduped.
 * `deduped` — true iff at least one redundant declaration was removed.
 * `remaining` — names declared more than once whose implementations are *not*
 * textually identical, so picking a winner would be a guess; the
 * `DUPLICATE-DECL` finding must persist for these. Honest partial repair.
 */
export interface DedupeResult {
	source: string;
	deduped: boolean;
	remaining: string[];
}

/**
 * The text of a function declaration with its leading visibility/ambient
 * modifiers stripped, so two declarations that differ *only* by an `export`
 * (or `default` / `declare`) keyword compare equal. `async` is preserved — it
 * changes the function's runtime contract, so it is part of the body identity,
 * not a visibility modifier. This is what makes the export-modifier-only twin
 * — the real Crewops corruption — provably mergeable rather than a guess.
 */
function bodyIdentity(decl: ts.FunctionDeclaration, sf: ts.SourceFile): string {
	return decl.getText(sf).replace(/^(?:export\s+|default\s+|declare\s+)+/, "");
}

function isExported(decl: ts.FunctionDeclaration): boolean {
	return decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Remove redundant top-level function implementations, keeping one, but *only*
 * when every duplicate of a name shares the same body identity (text modulo
 * visibility modifiers). When the bodies genuinely differ the name is left in
 * `remaining` and the source is untouched — choosing which implementation is
 * "right" would be a guess that could change consumer behavior, against the
 * north star (#260).
 *
 * Among identical twins the *exported* one is kept (an export-modifier-only
 * twin — `function X(){…}` then `export function X(){…}` — heals to the single
 * exported declaration), so the module's public surface is preserved. Pure:
 * AST-only, no disk.
 */
export function dedupeDuplicateFns(source: string, fileName = "file.tsx"): DedupeResult {
	const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

	const byName = new Map<string, ts.FunctionDeclaration[]>();
	for (const stmt of sf.statements) {
		if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
			const name = stmt.name.text;
			const list = byName.get(name) ?? [];
			list.push(stmt);
			byName.set(name, list);
		}
	}

	const remaining: string[] = [];
	const removals: Array<{ start: number; end: number }> = [];

	for (const [name, decls] of byName) {
		if (decls.length < 2) continue;
		const canonical = bodyIdentity(decls[0], sf);
		const allIdentical = decls.every((d) => bodyIdentity(d, sf) === canonical);
		if (!allIdentical) {
			remaining.push(name);
			continue;
		}
		// Keep one — the exported twin if present (preserves the public surface),
		// else the first; remove every other (with its leading trivia).
		const keep = decls.find(isExported) ?? decls[0];
		for (const d of decls) {
			if (d === keep) continue;
			removals.push({ start: d.getFullStart(), end: d.getEnd() });
		}
	}

	if (removals.length === 0) {
		return { source, deduped: false, remaining: remaining.sort() };
	}

	removals.sort((a, b) => b.start - a.start);
	let out = source;
	for (const r of removals) {
		out = out.slice(0, r.start) + out.slice(r.end);
	}
	return { source: out, deduped: true, remaining: remaining.sort() };
}
