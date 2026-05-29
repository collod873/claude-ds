import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import ts from "typescript";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";
import { toKebab, findInternalComponents } from "../drift/index.js";

/**
 * classify owns extraction (ADR-0015). When a tier file defines an inline
 * component — a non-exported, PascalCase function declaration living inside a
 * file that exports a *different* component — classify lifts it into its own
 * atom file under design-system/atoms/ and rewires the parent to import it.
 *
 * The previous (deleted) Path B of fixRawPrimitive did this with a regex
 * `findLocalDeps` that only carried over *local declarations* — it never
 * carried the *imports* the extracted body referenced, so atoms shipped with
 * missing imports (the bulk of the TS errors that stalled #195). This op does
 * the dependency analysis on the TypeScript AST instead: it computes the full
 * transitive closure of symbols the component reaches (imports, helper
 * functions, type aliases) and carries every one of them.
 */

const ATOM_DIR = "design-system/atoms";
const COMPOSITE_DIR = "design-system/composites";
const SOURCE_EXTS = [".tsx", ".ts"];
const SKIP_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx", ".d.ts"];

interface ImportInfo {
  /** Module specifier, e.g. "react" or "@/design-system/atoms/foo". */
  module: string;
  /** Names this import binds into module scope (default, namespace, named). */
  names: string[];
  /** Source text of the whole import statement, verbatim. */
  text: string;
  start: number;
  end: number;
}

interface LocalDecl {
  /** Every name this statement binds (a `const a, b` binds two). */
  names: string[];
  /** Source text of the declaration, verbatim. */
  text: string;
  start: number;
  end: number;
  exported: boolean;
  /** A pure type-only construct (type alias / interface) — no runtime value. */
  typeOnly: boolean;
}

interface ComponentNode {
  name: string;
  text: string;
  start: number;
  end: number;
  node: ts.FunctionDeclaration;
}

export interface Extraction {
  /** Component name, e.g. "DayList". */
  componentName: string;
  /** Parent file the component was lifted out of (cwd-relative). */
  parentRel: string;
  /** New atom file path (cwd-relative). */
  atomRel: string;
}

interface FilePlan {
  extractions: Extraction[];
  changes: Change[];
}

/**
 * Collect every identifier *referenced* (not declared) inside a node, skipping
 * the member side of property accesses (`foo.bar` → `foo`, never `bar`) and
 * JSX property names. Over-collection is harmless: callers only ever intersect
 * this set with real module-level binding names.
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
  // Include the node's own children only — but a FunctionDeclaration's body and
  // params are children, so forEachChild from the declaration covers them. The
  // declaration's own name is intentionally excluded (it's not in a child).
  return names;
}

function bindingNamesOf(decl: ts.VariableDeclaration | ts.BindingElement): string[] {
  const out: string[] = [];
  const name = decl.name;
  if (ts.isIdentifier(name)) {
    out.push(name.text);
  } else {
    // Destructuring pattern — collect each bound identifier.
    const walk = (b: ts.BindingName): void => {
      if (ts.isIdentifier(b)) out.push(b.text);
      else for (const el of b.elements) if (ts.isBindingElement(el)) walk(el.name);
    };
    walk(name);
  }
  return out;
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
}

function importBoundNames(imp: ts.ImportDeclaration): string[] {
  const names: string[] = [];
  const clause = imp.importClause;
  if (!clause) return names;
  if (clause.name) names.push(clause.name.text); // default import
  const nb = clause.namedBindings;
  if (nb) {
    if (ts.isNamespaceImport(nb)) names.push(nb.name.text);
    else for (const el of nb.elements) names.push(el.name.text);
  }
  return names;
}

/**
 * Build a trimmed copy of an import statement keeping only the specifiers in
 * `keep`. Returns null if nothing is kept. Preserves `import type`, default,
 * namespace, and per-specifier `type` modifiers / aliases.
 */
function trimImport(imp: ts.ImportDeclaration, sf: ts.SourceFile, keep: Set<string>): string | null {
  const clause = imp.importClause;
  const moduleText = imp.moduleSpecifier.getText(sf);
  if (!clause) return null; // side-effect import — nothing a component references
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

/** Insert an import before the first existing import, or at the top. */
function addImport(source: string, line: string): string {
  if (source.includes(line)) return source;
  const m = source.match(/^import\s/m);
  if (m && m.index !== undefined) {
    return source.slice(0, m.index) + line + "\n" + source.slice(m.index);
  }
  return line + "\n" + source;
}

function metaStub(): string {
  return `\nexport const meta = { kind: "atom" as const, examples: [{ name: "default", props: {} }] };\n`;
}

/**
 * Plan all extractions for a single parsed file.
 *
 * `takenAtomPaths` is the running set of atom paths that are unavailable as
 * extraction targets — existing atom files plus those already claimed by
 * earlier extractions this run. planFile reserves the paths it uses, so a
 * component whose kebab-name collides with an existing or already-claimed atom
 * is left inline rather than clobbering an unrelated atom (issue #209).
 */
function planFile(source: string, parentRel: string, canonicalAlias: string, takenAtomPaths: Set<string>): FilePlan {
  const internal = findInternalComponents(source);
  if (internal.length === 0) return { extractions: [], changes: [] };

  const sf = ts.createSourceFile(parentRel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // Index module-level imports, local declarations, and top-level components.
  const imports: ImportInfo[] = [];
  const locals: LocalDecl[] = [];
  const components = new Map<string, ComponentNode>();
  const detectedNames = new Set(internal.map(c => c.name));

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
    if (ts.isFunctionDeclaration(stmt) && stmt.name && detectedNames.has(stmt.name.text) && !isExported(stmt)) {
      components.set(stmt.name.text, {
        name: stmt.name.text,
        text: stmt.getText(sf),
        start: stmt.getStart(sf),
        end: stmt.getEnd(),
        node: stmt,
      });
      continue;
    }
    // Module-level local declarations the component might depend on.
    let names: string[] = [];
    let typeOnly = false;
    if (ts.isFunctionDeclaration(stmt) && stmt.name) names = [stmt.name.text];
    else if (ts.isVariableStatement(stmt)) names = stmt.declarationList.declarations.flatMap(d => bindingNamesOf(d));
    else if (ts.isTypeAliasDeclaration(stmt)) { names = [stmt.name.text]; typeOnly = true; }
    else if (ts.isInterfaceDeclaration(stmt)) { names = [stmt.name.text]; typeOnly = true; }
    else if (ts.isEnumDeclaration(stmt)) names = [stmt.name.text];
    else if (ts.isClassDeclaration(stmt) && stmt.name) names = [stmt.name.text];
    if (names.length > 0) {
      locals.push({ names, text: stmt.getText(sf), start: stmt.getStart(sf), end: stmt.getEnd(), exported: isExported(stmt), typeOnly });
    }
  }

  // Resolve detected components in declaration order.
  const comps = internal.map(c => components.get(c.name)).filter((c): c is ComponentNode => !!c);
  if (comps.length === 0) return { extractions: [], changes: [] };

  const atomRelFor = (name: string): string => `${ATOM_DIR}/${toKebab(name)}.tsx`;
  const importLineFor = (name: string): string =>
    `import { ${name} } from "${canonicalAlias}/atoms/${toKebab(name)}";`;

  // Only extract components whose target atom path is free (issue #209):
  //   - not the parent file itself (the file's own primary component, which
  //     `findInternalComponents` can flag when it's declared before its export),
  //   - not an existing atom, and
  //   - not already claimed by another extraction this run.
  // Anything that collides stays inline — extracting it would overwrite an
  // unrelated atom or have two extractions fight over one path. Done before
  // assembling so the parent rewrite never imports/removes a skipped component.
  const extractable: ComponentNode[] = [];
  for (const comp of comps) {
    const atomRel = atomRelFor(comp.name);
    if (atomRel === parentRel) continue;
    if (takenAtomPaths.has(atomRel)) continue;
    takenAtomPaths.add(atomRel);
    extractable.push(comp);
  }
  if (extractable.length === 0) return { extractions: [], changes: [] };

  // Track which local decls get *moved out* of the parent (used only by the
  // extracted set) vs *copied* (also used elsewhere in the parent).
  const movedLocalKeys = new Set<number>(); // index into `locals`
  const removeRanges: { start: number; end: number }[] = [];
  const extractions: Extraction[] = [];
  const atomChanges: Change[] = [];
  const parentImportLines: string[] = [];

  for (const comp of extractable) {
    // Transitive closure of referenced names, seeded by the component body and
    // growing through any local decls it pulls in.
    const seedNodes: ts.Node[] = [comp.node];
    const referenced = new Set<string>();
    const includedLocalIdx = new Set<number>();
    const queue = [...seedNodes];
    while (queue.length > 0) {
      const n = queue.shift()!;
      for (const name of collectReferencedNames(n)) referenced.add(name);
      // Pull in any not-yet-included local decl this node references. Exported
      // *runtime* decls (consts, functions, enums, classes) are skipped: copying
      // them would duplicate a value, and the parent must keep ownership.
      // Exported *type-only* decls (type aliases, interfaces) DO get carried —
      // a type has no runtime identity, so a copy in the atom is sound, and the
      // alternative (importing it from the parent composite) would be an
      // atom→composite layering violation (issue #196).
      locals.forEach((d, i) => {
        if (includedLocalIdx.has(i)) return;
        if (d.exported && !d.typeOnly) return;
        if (d.names.some(nm => referenced.has(nm))) {
          includedLocalIdx.add(i);
          queue.push(...findStatementByRange(sf, d.start, d.end));
        }
      });
    }

    // Imports the closure needs.
    const selfKebab = toKebab(comp.name);
    const neededImports: string[] = [];
    for (const imp of imports) {
      if (!imp.names.some(nm => referenced.has(nm))) continue;
      // Self-import guard: if the parent already imports from an atom whose
      // kebab path matches the one we're creating, carrying that import would
      // make the new atom import itself. Drop it — the symbol stays resolved by
      // the atom's own (about-to-be-written) declarations.
      if (imp.module.replace(/\.\w+$/, "").endsWith(`/atoms/${selfKebab}`)) continue;
      const trimmed = trimImport(findImportNode(sf, imp.start)!, sf, referenced);
      if (trimmed) neededImports.push(trimmed);
    }

    // Other extracted components this one references → import them as atoms.
    // Only components actually being extracted qualify; a referenced component
    // left inline (collision-skipped) stays resolved by the parent.
    const crossAtomImports: string[] = [];
    for (const other of extractable) {
      if (other.name !== comp.name && referenced.has(other.name)) {
        crossAtomImports.push(importLineFor(other.name));
      }
    }

    // Local decls to carry into the atom, in source order.
    const carried = locals
      .filter((_, i) => includedLocalIdx.has(i))
      .sort((a, b) => a.start - b.start);

    // Decide move vs copy for each carried decl: is the name referenced
    // anywhere in the parent *outside* the extracted components + carried decls?
    const protectedRanges = [
      ...extractable.map(c => ({ start: c.start, end: c.end })),
      ...carried.map(d => ({ start: d.start, end: d.end })),
    ];
    for (let i = 0; i < locals.length; i++) {
      if (!includedLocalIdx.has(i)) continue;
      const d = locals[i];
      // An exported decl is always copied, never moved: external files import it
      // by name, and `referencedOutside` only sees this file — so a "not used
      // elsewhere" verdict would be a false positive that breaks those importers.
      if (d.exported) continue;
      const usedElsewhere = d.names.some(nm => referencedOutside(sf, nm, protectedRanges));
      if (!usedElsewhere && !movedLocalKeys.has(i)) {
        movedLocalKeys.add(i);
        removeRanges.push({ start: d.start, end: d.end });
      }
    }

    // Assemble the atom file.
    const head = [...new Set([...neededImports, ...crossAtomImports])].join("\n");
    const body = carried.map(d => d.text).join("\n\n");
    const exported = `export ${comp.text}`;
    const atomContent =
      (head ? head + "\n\n" : "") +
      (body ? body + "\n\n" : "") +
      exported +
      "\n" +
      metaStub();

    const atomRel = atomRelFor(comp.name);
    atomChanges.push({ kind: "write", path: atomRel, before: null, after: Buffer.from(atomContent) });
    parentImportLines.push(importLineFor(comp.name));
    extractions.push({ componentName: comp.name, parentRel, atomRel });

    // Remove the component body from the parent.
    removeRanges.push({ start: comp.start, end: comp.end });
  }

  // Apply parent edits: delete ranges (descending) then add imports.
  let parentSource = source;
  removeRanges.sort((a, b) => b.start - a.start);
  for (const r of removeRanges) {
    parentSource = parentSource.slice(0, r.start) + parentSource.slice(r.end);
  }
  parentSource = parentSource.replace(/\n{3,}/g, "\n\n");
  for (const line of parentImportLines) parentSource = addImport(parentSource, line);

  const changes: Change[] = [
    ...atomChanges,
    { kind: "write", path: parentRel, before: Buffer.from(source), after: Buffer.from(parentSource) },
  ];
  return { extractions, changes };
}

/** Find the top-level statement nodes whose span matches [start,end). */
function findStatementByRange(sf: ts.SourceFile, start: number, end: number): ts.Node[] {
  for (const stmt of sf.statements) {
    if (stmt.getStart(sf) === start && stmt.getEnd() === end) return [stmt];
  }
  return [];
}

function findImportNode(sf: ts.SourceFile, start: number): ts.ImportDeclaration | null {
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.getStart(sf) === start) return stmt;
  }
  return null;
}

/** Is `name` referenced anywhere in the file outside the given ranges? */
function referencedOutside(sf: ts.SourceFile, name: string, ranges: { start: number; end: number }[]): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name) {
      const pos = n.getStart(sf);
      const inside = ranges.some(r => pos >= r.start && pos < r.end);
      const p = n.parent;
      const isMemberName =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        // The declaration's own name occurrence doesn't count as usage.
        (ts.isFunctionDeclaration(p) && p.name === n) ||
        (ts.isVariableDeclaration(p) && p.name === n) ||
        (ts.isTypeAliasDeclaration(p) && p.name === n) ||
        (ts.isInterfaceDeclaration(p) && p.name === n);
      if (!inside && !isMemberName) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Recursively collect tier files (atoms + composites) to scan. */
async function collectTierFiles(cwd: string): Promise<string[]> {
  const roots = [ATOM_DIR, COMPOSITE_DIR];
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
      if (!SOURCE_EXTS.some(ext => e.name.endsWith(ext))) continue;
      if (SKIP_SUFFIXES.some(s => e.name.endsWith(s))) continue;
      out.push(childRel);
    }
  }
  for (const r of roots) await walk(r);
  return out;
}

/**
 * Build an Operation that extracts inline components from the design-system
 * tier files into their own atoms. The returned object also exposes the
 * planned `extractions` after `plan()` runs, so the caller can print a summary.
 */
export function extractInlineComponents(canonicalAlias: string): Operation & { extractions: Extraction[] } {
  const op = {
    name: "extract-inline-components",
    extractions: [] as Extraction[],
    async plan(ctx: ProjectContext): Promise<Change[]> {
      const files = await collectTierFiles(ctx.cwd);
      // Seed the claimed-paths set with every existing atom so extraction never
      // overwrites one (issue #209). planFile reserves further paths as it goes.
      const takenAtomPaths = new Set<string>(files.filter(f => f.startsWith(`${ATOM_DIR}/`)));
      const changes: Change[] = [];
      op.extractions = [];
      for (const rel of files) {
        let source: string;
        try {
          source = await readFile(join(ctx.cwd, rel), "utf8");
        } catch {
          continue;
        }
        const plan = planFile(source, rel, canonicalAlias, takenAtomPaths);
        op.extractions.push(...plan.extractions);
        changes.push(...plan.changes);
      }
      return changes;
    },
  };
  return op;
}

// Exported for unit testing the pure planner. `takenAtomPaths` defaults to an
// empty set so single-file tests need not thread it.
export const __test = {
  planFile: (source: string, parentRel: string, canonicalAlias: string, takenAtomPaths: Set<string> = new Set()): FilePlan =>
    planFile(source, parentRel, canonicalAlias, takenAtomPaths),
};
