import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { analyzeResolution } from "../integrity/resolve-symbols.js";
import type { Change, Operation, PlanResult } from "../operation.js";
import type { ProjectContext } from "../project.js";

/**
 * classify owns extraction (ADR-0015). When a pre-existing atom was extracted
 * without its parent-local helper closure (the pre-#195 era), it ends up with
 * unresolved symbols that `audit --fix` CANNOT heal (no importable source for
 * them; code-motion is classify's job, not audit's).
 *
 * This operation repairs those atoms at classify-time by:
 *   1. Walking every existing atom for unresolved symbols (analyzeResolution).
 *   2. For each unresolved symbol, searching all composites for a module-private
 *      (non-exported) declaration of that name. Only symbols that match a
 *      private composite decl are considered "parent-local helpers". Symbols
 *      that are NOT found in any composite (e.g. missing imports for Button,
 *      cn, React) are left alone — `audit --fix` handles those via
 *      INTEGRITY-UNRESOLVED-SYMBOL repair.
 *   3. Computing the transitive closure of the identified helpers (a helper may
 *      depend on other private helpers in the same composite).
 *   4. Prepending the carried helpers into the atom so it becomes self-contained
 *      (for the parent-local subset at least).
 *   5. Removing the helpers from the composite ONLY when the composite no longer
 *      references them outside their own declarations. When the composite still
 *      uses them, they are copied (atom gets them, composite keeps them).
 *
 * Honesty fallback (required by #261 acceptance):
 *   If the closure analysis CANNOT safely determine where a helper lives (e.g.
 *   the symbol maps to an EXPORTED composite decl, or to helpers across multiple
 *   composites that can't be merged, or the analysis fails the post-repair gate),
 *   we do NOT write the atom with a dangling reference. Instead we prepend an
 *   EXTRACTION_NEEDED marker comment into the atom and leave the finding visible.
 *
 * ADR-0014 gate: after building the repaired atom, analyzeResolution is run
 * again. If the parent-local symbols remain unresolved in the repaired version,
 * we fall back to the EXTRACTION_NEEDED marker.
 */

export const BACKFILL_EXTRACTION_NEEDED_MARKER =
	"// claude-ds: EXTRACTION_NEEDED — parent-local helper could not be carried safely";

const ATOM_DIR = "design-system/atoms";
const COMPOSITE_DIR = "design-system/composites";
const SOURCE_EXTS = [".tsx", ".ts"];
const SKIP_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx", ".d.ts"];

export interface BackfillResult {
	atomRel: string;
	kind: "healed" | "marker-added" | "skipped";
	carriedSymbols?: string[];
	unresolvedSymbols?: string[];
}

interface LocalDecl {
	names: string[];
	text: string;
	start: number;
	end: number;
	exported: boolean;
	/** True for type-only constructs (type aliases, interfaces). No runtime value. */
	typeOnly: boolean;
}

interface ImportInfo {
	module: string;
	names: string[];
	text: string;
	start: number;
	end: number;
}

function isExported(node: ts.Node): boolean {
	const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
	return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function bindingNamesOf(decl: ts.VariableDeclaration | ts.BindingElement): string[] {
	const out: string[] = [];
	const name = decl.name;
	if (ts.isIdentifier(name)) {
		out.push(name.text);
	} else {
		const walk = (b: ts.BindingName): void => {
			if (ts.isIdentifier(b)) out.push(b.text);
			else for (const el of b.elements) if (ts.isBindingElement(el)) walk(el.name);
		};
		walk(name);
	}
	return out;
}

function importBoundNames(imp: ts.ImportDeclaration): string[] {
	const names: string[] = [];
	const clause = imp.importClause;
	if (!clause) return names;
	if (clause.name) names.push(clause.name.text);
	const nb = clause.namedBindings;
	if (nb) {
		if (ts.isNamespaceImport(nb)) names.push(nb.name.text);
		else for (const el of nb.elements) names.push(el.name.text);
	}
	return names;
}

/**
 * Collect every identifier *referenced* (not declared) inside a node.
 * Over-collection is harmless — callers intersect with real module-level binding names.
 */
function collectReferencedNames(node: ts.Node): Set<string> {
	const names = new Set<string>();
	const visit = (n: ts.Node): void => {
		if (ts.isIdentifier(n)) {
			const p = n.parent;
			const isMemberName =
				(ts.isPropertyAccessExpression(p) && p.name === n) ||
				(ts.isQualifiedName(p) && p.right === n) ||
				(ts.isPropertyAssignment(p) && p.name === n) ||
				(ts.isPropertySignature(p) && p.name === n);
			if (!isMemberName) names.add(n.text);
		}
		ts.forEachChild(n, visit);
	};
	ts.forEachChild(node, visit);
	return names;
}

/**
 * Parse a TS/TSX source file and extract the module-level local declarations
 * and imports.
 */
function parseLocalsAndImports(
	source: string,
	fileName: string,
): {
	locals: LocalDecl[];
	imports: ImportInfo[];
} {
	const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const locals: LocalDecl[] = [];
	const imports: ImportInfo[] = [];

	for (const stmt of sf.statements) {
		if (ts.isImportDeclaration(stmt)) {
			imports.push({
				module: (stmt.moduleSpecifier as ts.StringLiteral).text,
				names: importBoundNames(stmt),
				text: stmt.getText(sf),
				start: stmt.getStart(sf),
				end: stmt.getEnd(),
			});
			continue;
		}
		let names: string[] = [];
		let typeOnly = false;
		if (ts.isFunctionDeclaration(stmt) && stmt.name) {
			names = [stmt.name.text];
		} else if (ts.isVariableStatement(stmt)) {
			names = stmt.declarationList.declarations.flatMap((d) => bindingNamesOf(d));
		} else if (ts.isTypeAliasDeclaration(stmt)) {
			names = [stmt.name.text];
			typeOnly = true;
		} else if (ts.isInterfaceDeclaration(stmt)) {
			names = [stmt.name.text];
			typeOnly = true;
		} else if (ts.isEnumDeclaration(stmt)) {
			names = [stmt.name.text];
		} else if (ts.isClassDeclaration(stmt) && stmt.name) {
			names = [stmt.name.text];
		}
		if (names.length > 0) {
			locals.push({
				names,
				text: stmt.getText(sf),
				start: stmt.getStart(sf),
				end: stmt.getEnd(),
				exported: isExported(stmt),
				typeOnly,
			});
		}
	}

	return { locals, imports };
}

/**
 * Given a set of parent-local symbol names (proven non-exported, found in
 * `compositeLocals`), compute the TRANSITIVE CLOSURE of private declarations
 * that must be carried into the atom. Grows through any private composite locals
 * those helpers themselves reference.
 *
 * Returns null if any symbol in the closure maps to an EXPORTED declaration
 * (cannot be safely carried — duplicating a runtime value), or if a transitively-
 * required symbol isn't found.
 */
function computeHelperClosure(
	seedNames: Set<string>,
	compositeLocals: LocalDecl[],
	compositeSource: string,
	compositeFileName: string,
): Set<number> | null {
	const sf = ts.createSourceFile(
		compositeFileName,
		compositeSource,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);

	// Build a lookup: name → local index (all locals)
	const nameToIdx = new Map<string, number>();
	for (let i = 0; i < compositeLocals.length; i++) {
		for (const nm of compositeLocals[i].names) nameToIdx.set(nm, i);
	}

	const includedIdx = new Set<number>();
	const queue: string[] = [...seedNames];

	while (queue.length > 0) {
		const name = queue.shift()!;
		const idx = nameToIdx.get(name);
		if (idx === undefined) {
			// Symbol not found in this composite — cannot carry
			return null;
		}
		if (includedIdx.has(idx)) continue;
		const decl = compositeLocals[idx];
		// Cannot carry exported runtime declarations — that would duplicate the value
		if (decl.exported) return null;
		includedIdx.add(idx);

		// Transitively pull in helpers this decl references
		const stmtNode = findStmtNode(sf, decl.start, decl.end);
		if (stmtNode) {
			for (const refName of collectReferencedNames(stmtNode)) {
				const depIdx = nameToIdx.get(refName);
				if (depIdx !== undefined && !includedIdx.has(depIdx)) {
					const dep = compositeLocals[depIdx];
					if (!dep.exported) {
						for (const nm of dep.names) {
							if (!includedIdx.has(nameToIdx.get(nm) ?? -1)) {
								queue.push(nm);
							}
						}
					}
				}
			}
		}
	}

	return includedIdx;
}

function findStmtNode(sf: ts.SourceFile, start: number, end: number): ts.Node | null {
	for (const stmt of sf.statements) {
		if (stmt.getStart(sf) === start && stmt.getEnd() === end) return stmt;
	}
	return null;
}

/**
 * Check whether a name is still referenced in the composite OUTSIDE the helper
 * declarations that are being moved (i.e. at runtime in the composite's own
 * logic). If yes, the helper must be COPIED (stays in composite + added to atom).
 * If no, it can be MOVED (removed from composite).
 */
function isReferencedOutsideHelpers(
	sf: ts.SourceFile,
	name: string,
	helperRanges: { start: number; end: number }[],
): boolean {
	let found = false;
	const visit = (n: ts.Node): void => {
		if (found) return;
		if (ts.isIdentifier(n) && n.text === name) {
			const pos = n.getStart(sf);
			const inside = helperRanges.some((r) => pos >= r.start && pos < r.end);
			const p = n.parent;
			const isDeclarationName =
				(ts.isFunctionDeclaration(p) && p.name === n) ||
				(ts.isVariableDeclaration(p) && p.name === n) ||
				(ts.isTypeAliasDeclaration(p) && p.name === n) ||
				(ts.isInterfaceDeclaration(p) && p.name === n) ||
				(ts.isPropertyAccessExpression(p) && p.name === n) ||
				(ts.isPropertyAssignment(p) && p.name === n);
			if (!inside && !isDeclarationName) found = true;
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return found;
}

/** Insert a block of text after the last import statement (before the first non-import decl). */
function insertHelpersAfterImports(source: string, helpers: string): string {
	const sf = ts.createSourceFile(
		"_tmp.tsx",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);
	// Find position after the last import statement
	let lastImportEnd = 0;
	for (const stmt of sf.statements) {
		if (ts.isImportDeclaration(stmt)) {
			lastImportEnd = stmt.getEnd();
		}
	}
	if (lastImportEnd === 0) {
		// No imports — prepend at the very start
		return `${helpers}\n\n${source}`;
	}
	// Insert after the last import
	return (
		source.slice(0, lastImportEnd) +
		"\n\n" +
		helpers +
		"\n\n" +
		source.slice(lastImportEnd).replace(/^\s*\n/, "")
	);
}

function addImportLine(source: string, line: string): string {
	if (source.includes(line.trim())) return source;
	const m = source.match(/^import\s/m);
	if (m && m.index !== undefined) {
		return `${source.slice(0, m.index) + line}\n${source.slice(m.index)}`;
	}
	return `${line}\n${source}`;
}

/** Collect all tier files in a directory. */
async function collectDirFiles(cwd: string, dir: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(rel: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(join(cwd, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const childRel = `${rel}/${e.name}`;
			if (e.isDirectory()) {
				await walk(childRel);
				continue;
			}
			if (!e.isFile()) continue;
			if (!SOURCE_EXTS.some((ext) => e.name.endsWith(ext))) continue;
			if (SKIP_SUFFIXES.some((s) => e.name.endsWith(s))) continue;
			out.push(childRel);
		}
	}
	await walk(dir);
	return out;
}

/**
 * Build an Operation that, for each existing atom with unresolved symbols that
 * can be traced to parent-local (non-exported) composite declarations, carries
 * those declarations into the atom. This repairs the pre-#195-era extraction
 * defect where atoms were created without their helper closures (ADR-0015, #261).
 *
 * Critical distinction from `extractInlineComponents`:
 *   - `extractInlineComponents` creates NEW atoms from inline components inside
 *     composites.
 *   - `backfillAtomHelpers` repairs EXISTING atoms that are missing declarations
 *     they need (parent-local helpers left behind during old extraction).
 *
 * Only operates on symbols that are provably parent-local (found as private
 * non-exported declarations in a composite). Symbols that need imports (e.g.
 * `Button`, `cn`) are left for `audit --fix` to handle — this operation only
 * moves code, never guesses imports.
 */
/** Outcome reported on `RunReport.ops[i].outcome` — the per-atom backfill verdicts. */
export interface BackfillAtomHelpersOutcome {
	results: BackfillResult[];
}

export function backfillAtomHelpers(): Operation<BackfillAtomHelpersOutcome> {
	return {
		name: "backfill-atom-helpers",
		async plan(ctx: ProjectContext): Promise<PlanResult<BackfillAtomHelpersOutcome>> {
			const results: BackfillResult[] = [];
			const changes: Change[] = [];

			const atomFiles = await collectDirFiles(ctx.cwd, ATOM_DIR);
			const compositeFiles = await collectDirFiles(ctx.cwd, COMPOSITE_DIR);

			// Build a map of all composite sources and their parsed locals.
			// Skip composites that are themselves corrupt (have unresolved symbols or
			// duplicate declarations) — we can't safely extract from a broken composite.
			interface CompositeParsed {
				rel: string;
				source: string;
				locals: LocalDecl[];
				imports: ImportInfo[];
				sf: ts.SourceFile;
			}
			const composites: CompositeParsed[] = [];
			for (const rel of compositeFiles) {
				let source: string;
				try {
					source = await readFile(join(ctx.cwd, rel), "utf8");
				} catch {
					continue;
				}
				const { unresolved, duplicateFns } = analyzeResolution(source, rel);
				if (unresolved.length > 0 || duplicateFns.length > 0) continue;

				const { locals, imports } = parseLocalsAndImports(source, rel);
				const sf = ts.createSourceFile(
					rel,
					source,
					ts.ScriptTarget.Latest,
					true,
					ts.ScriptKind.TSX,
				);
				composites.push({ rel, source, locals, imports, sf });
			}

			// Build two global name→composite lookup maps:
			//
			// privateNameToComp: name → composite that declares it as a PRIVATE
			//   (non-exported) decl. These are the helpers we can carry into atoms.
			//   If a name appears as private in multiple composites, we take the FIRST
			//   (stable since compositeFiles is path-sorted).
			//
			// exportedRuntimeInComposite: name → true when ANY composite exports the name
			//   as a RUNTIME (non-type-only) decl. Symbols in this set cannot be carried
			//   (duplicating a runtime value identity, and importing from a composite would
			//   be an atom→composite layering violation). They require an EXTRACTION_NEEDED
			//   marker when unresolved in an atom.
			//   NOTE: exported type-only decls (type aliases, interfaces) are NOT included
			//   here — a type can be imported from a composite without a layering violation,
			//   and `audit --fix` handles those via INTEGRITY-UNRESOLVED-SYMBOL repair.
			const privateNameToComp = new Map<string, CompositeParsed>();
			const exportedRuntimeInComposite = new Set<string>();
			for (const comp of composites) {
				for (const decl of comp.locals) {
					for (const nm of decl.names) {
						if (decl.exported && !decl.typeOnly) {
							exportedRuntimeInComposite.add(nm);
						} else if (!decl.exported) {
							if (!privateNameToComp.has(nm)) {
								privateNameToComp.set(nm, comp);
							}
						}
						// exported type-only (type alias / interface): neither set —
						// these need an import, which audit --fix handles, not code-motion.
					}
				}
			}

			for (const atomRel of atomFiles) {
				let atomSource: string;
				try {
					atomSource = await readFile(join(ctx.cwd, atomRel), "utf8");
				} catch {
					continue;
				}

				// Skip atoms that already have the marker (already processed or manually marked)
				if (atomSource.includes(BACKFILL_EXTRACTION_NEEDED_MARKER)) {
					results.push({ atomRel, kind: "skipped" });
					continue;
				}

				const { unresolved } = analyzeResolution(atomSource, atomRel);
				if (unresolved.length === 0) continue; // atom is already clean

				// Partition unresolved symbols into three categories:
				//   parentLocalPrivate — found as PRIVATE non-exported decl in a composite
				//                        → carry it
				//   parentLocalExported — found as EXPORTED decl in a composite
				//                         → CANNOT carry (layering violation); add marker
				//   notInComposites     — not found in any composite
				//                         → missing import; leave for audit --fix
				const parentLocalPrivate = new Set<string>();
				const parentLocalExported = new Set<string>();
				for (const name of unresolved) {
					if (privateNameToComp.has(name)) {
						parentLocalPrivate.add(name);
					} else if (exportedRuntimeInComposite.has(name)) {
						parentLocalExported.add(name);
					}
					// else: not in any composite → leave for audit --fix
				}

				// If ANY symbol is exported-composite (can't import, can't carry), emit marker.
				if (parentLocalExported.size > 0) {
					if (!atomSource.includes(BACKFILL_EXTRACTION_NEEDED_MARKER)) {
						const marked =
							BACKFILL_EXTRACTION_NEEDED_MARKER +
							" — composite-exported symbols cannot be carried (atom→composite layering violation): " +
							[...parentLocalExported].join(", ") +
							"\n" +
							atomSource;
						changes.push({
							kind: "write",
							path: atomRel,
							before: Buffer.from(atomSource),
							after: Buffer.from(marked),
						});
						results.push({
							atomRel,
							kind: "marker-added",
							unresolvedSymbols: [...parentLocalExported],
						});
					} else {
						results.push({ atomRel, kind: "skipped" });
					}
					continue;
				}

				if (parentLocalPrivate.size === 0) {
					// No parent-local private symbols — nothing this operation can do.
					// Leave the atom alone; audit --fix handles the unresolved imports.
					continue;
				}

				// All parent-local private symbols must come from the SAME composite (we
				// can't merge helpers from multiple composites in one atom without creating
				// tangled ownership). If they span multiple composites, add the marker.
				const ownerComps = new Set<CompositeParsed>();
				for (const nm of parentLocalPrivate) {
					const comp = privateNameToComp.get(nm);
					if (comp) ownerComps.add(comp);
				}

				if (ownerComps.size > 1) {
					// Helpers live in multiple composites — ambiguous ownership.
					if (!atomSource.includes(BACKFILL_EXTRACTION_NEEDED_MARKER)) {
						const marked =
							BACKFILL_EXTRACTION_NEEDED_MARKER +
							" — helpers span multiple composites: " +
							[...parentLocalPrivate].join(", ") +
							"\n" +
							atomSource;
						changes.push({
							kind: "write",
							path: atomRel,
							before: Buffer.from(atomSource),
							after: Buffer.from(marked),
						});
						results.push({
							atomRel,
							kind: "marker-added",
							unresolvedSymbols: [...parentLocalPrivate],
						});
					} else {
						results.push({ atomRel, kind: "skipped" });
					}
					continue;
				}

				const ownerComp = [...ownerComps][0];

				// Compute the transitive closure of all parent-local private helpers from this composite.
				const closure = computeHelperClosure(
					parentLocalPrivate,
					ownerComp.locals,
					ownerComp.source,
					ownerComp.rel,
				);
				if (closure === null) {
					// Closure hit an exported decl or a missing symbol — cannot safely carry.
					if (!atomSource.includes(BACKFILL_EXTRACTION_NEEDED_MARKER)) {
						const marked =
							BACKFILL_EXTRACTION_NEEDED_MARKER +
							" — closure contains exported or missing symbols: " +
							[...parentLocalPrivate].join(", ") +
							"\n" +
							atomSource;
						changes.push({
							kind: "write",
							path: atomRel,
							before: Buffer.from(atomSource),
							after: Buffer.from(marked),
						});
						results.push({
							atomRel,
							kind: "marker-added",
							unresolvedSymbols: [...parentLocalPrivate],
						});
					} else {
						results.push({ atomRel, kind: "skipped" });
					}
					continue;
				}

				// Gather the helpers to carry (in source order)
				const carriedDecls = ownerComp.locals
					.filter((_, i) => closure.has(i))
					.sort((a, b) => a.start - b.start);

				// Collect names referenced by the carried helpers
				const helperRefs = new Set<string>();
				for (const decl of carriedDecls) {
					const stmtNode = findStmtNode(ownerComp.sf, decl.start, decl.end);
					if (stmtNode) {
						for (const nm of collectReferencedNames(stmtNode)) helperRefs.add(nm);
					}
				}

				// Find composite imports that the helpers reference and that are not
				// already in the atom (don't re-import what's already imported)
				const atomSf = ts.createSourceFile(
					atomRel,
					atomSource,
					ts.ScriptTarget.Latest,
					true,
					ts.ScriptKind.TSX,
				);
				const atomBound = new Set<string>();
				for (const stmt of atomSf.statements) {
					if (ts.isImportDeclaration(stmt)) {
						for (const nm of importBoundNames(stmt)) atomBound.add(nm);
					} else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
						atomBound.add(stmt.name.text);
					} else if (ts.isVariableStatement(stmt)) {
						for (const d of stmt.declarationList.declarations) {
							if (ts.isIdentifier(d.name)) atomBound.add(d.name.text);
						}
					} else if (ts.isTypeAliasDeclaration(stmt)) {
						atomBound.add(stmt.name.text);
					} else if (ts.isInterfaceDeclaration(stmt)) {
						atomBound.add(stmt.name.text);
					}
				}

				// Also exclude the carried helper names themselves (they'll be in the atom)
				for (const decl of carriedDecls) {
					for (const nm of decl.names) atomBound.add(nm);
				}

				const helperImportLines: string[] = [];
				for (const imp of ownerComp.imports) {
					const needed = imp.names.filter((nm) => helperRefs.has(nm) && !atomBound.has(nm));
					if (needed.length === 0) continue;
					const neededSet = new Set(needed);
					const impNode = findImportNode(ownerComp.sf, imp.start);
					if (!impNode) continue;
					const trimmed = trimImport(impNode, ownerComp.sf, neededSet);
					if (trimmed) helperImportLines.push(trimmed);
				}

				// Build the repaired atom: add helper imports, then insert helper declarations
				let repairedAtom = atomSource;
				for (const imp of helperImportLines) {
					repairedAtom = addImportLine(repairedAtom, imp);
				}
				const helperBlock = carriedDecls.map((d) => d.text).join("\n\n");
				if (helperBlock) {
					repairedAtom = insertHelpersAfterImports(repairedAtom, helperBlock);
				}

				// ADR-0014 gate: verify the parent-local private symbols are now resolved
				const { unresolved: afterUnresolved } = analyzeResolution(repairedAtom, atomRel);
				const stillMissingParentLocal = [...parentLocalPrivate].filter((nm) =>
					afterUnresolved.includes(nm),
				);
				if (stillMissingParentLocal.length > 0) {
					// Still unresolved after repair attempt → honesty fallback
					if (!atomSource.includes(BACKFILL_EXTRACTION_NEEDED_MARKER)) {
						const marked =
							BACKFILL_EXTRACTION_NEEDED_MARKER +
							" — unresolved after repair attempt: " +
							stillMissingParentLocal.join(", ") +
							"\n" +
							atomSource;
						changes.push({
							kind: "write",
							path: atomRel,
							before: Buffer.from(atomSource),
							after: Buffer.from(marked),
						});
						results.push({
							atomRel,
							kind: "marker-added",
							unresolvedSymbols: stillMissingParentLocal,
						});
					} else {
						results.push({ atomRel, kind: "skipped" });
					}
					continue;
				}

				// Determine which helpers can be moved (removed) from the composite vs. copied.
				// Only move a helper if the composite no longer references it outside the helper defs.
				const helperRanges = carriedDecls.map((d) => ({ start: d.start, end: d.end }));
				const toRemove: { start: number; end: number }[] = [];
				for (const decl of carriedDecls) {
					const stillUsed = decl.names.some((nm) =>
						isReferencedOutsideHelpers(ownerComp.sf, nm, helperRanges),
					);
					if (!stillUsed) {
						toRemove.push({ start: decl.start, end: decl.end });
					}
				}

				// Write the repaired atom
				changes.push({
					kind: "write",
					path: atomRel,
					before: Buffer.from(atomSource),
					after: Buffer.from(repairedAtom),
				});

				// Rewrite the composite if any helpers were moved out
				if (toRemove.length > 0) {
					let compSource = ownerComp.source;
					toRemove.sort((a, b) => b.start - a.start);
					for (const r of toRemove) {
						compSource = compSource.slice(0, r.start) + compSource.slice(r.end);
					}
					compSource = compSource.replace(/\n{3,}/g, "\n\n");
					changes.push({
						kind: "write",
						path: ownerComp.rel,
						before: Buffer.from(ownerComp.source),
						after: Buffer.from(compSource),
					});
				}

				results.push({
					atomRel,
					kind: "healed",
					carriedSymbols: [...parentLocalPrivate],
				});
			}

			return { changes, outcome: { results } };
		},
	};
}

function findImportNode(sf: ts.SourceFile, start: number): ts.ImportDeclaration | null {
	for (const stmt of sf.statements) {
		if (ts.isImportDeclaration(stmt) && stmt.getStart(sf) === start) return stmt;
	}
	return null;
}

function trimImport(
	imp: ts.ImportDeclaration,
	sf: ts.SourceFile,
	keep: Set<string>,
): string | null {
	const clause = imp.importClause;
	const moduleText = imp.moduleSpecifier.getText(sf);
	if (!clause) return null;
	const typeOnly = clause.isTypeOnly ? "type " : "";

	const defaultName = clause.name && keep.has(clause.name.text) ? clause.name.text : null;

	let namespace: string | null = null;
	const named: string[] = [];
	const nb = clause.namedBindings;
	if (nb) {
		if (ts.isNamespaceImport(nb)) {
			if (keep.has(nb.name.text)) namespace = nb.name.text;
		} else {
			for (const el of nb.elements) {
				if (keep.has(el.name.text)) named.push(el.getText(sf));
			}
		}
	}

	if (!defaultName && !namespace && named.length === 0) return null;

	const parts: string[] = [];
	if (defaultName) parts.push(defaultName);
	if (namespace) parts.push(`* as ${namespace}`);
	if (named.length > 0) parts.push(`{ ${named.join(", ")} }`);
	return `import ${typeOnly}${parts.join(", ")} from ${moduleText};`;
}

// Exported for unit testing
export const __test = {
	parseLocalsAndImports,
	computeHelperClosure,
	isReferencedOutsideHelpers,
};
