import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { detectTsconfigPaths } from "../ds-aliases.js";
import type { RepairEnv, SymbolSource } from "./repair-symbols.js";

/**
 * Options for assembling a repair environment over a consumer project.
 * `fileName` is the file being repaired (cwd-relative); it is excluded from the
 * import-graph scan so a file never resolves a symbol against its own
 * (now-stripped) imports. `srcRoot` locates the tsconfig that declares the DS
 * path aliases (defaults to the repo root, where Crewops keeps it).
 */
export interface RepairEnvOptions {
  cwd: string;
  fileName: string;
  srcRoot?: string;
}

const SCAN_DIRS = ["src", "design-system", "app", "components", "lib"];
const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const recurse = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await recurse(join(dir, e.name));
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf(".");
        if (dot >= 0 && SCAN_EXTS.has(e.name.slice(dot))) out.push(join(dir, e.name));
      }
    }
  };
  await recurse(root);
  return out;
}

/**
 * Index every plain (non-aliased) named and default import across a set of
 * source texts: `local name → set of specifiers it is imported from`. Aliased
 * (`X as Y`) and namespace (`* as NS`) imports are intentionally skipped — a
 * symbol's binding name cannot be safely reconstructed from them.
 *
 * Pure and self-contained; the disk walk lives in `buildRepairEnv`.
 */
export function indexImportGraph(sources: string[]): {
  named: Map<string, Set<string>>;
  defaults: Map<string, Set<string>>;
} {
  const named = new Map<string, Set<string>>();
  const defaults = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, spec: string): void => {
    const set = map.get(key) ?? new Set<string>();
    set.add(spec);
    map.set(key, set);
  };

  const importRe = /import\s+([^;]+?)\s+from\s+["']([^"']+)["']/g;
  for (const source of sources) {
    let m: RegExpExecArray | null;
    importRe.lastIndex = 0;
    while ((m = importRe.exec(source)) !== null) {
      const clause = m[1].trim();
      const spec = m[2];

      const braceStart = clause.indexOf("{");
      if (braceStart >= 0) {
        const braceEnd = clause.indexOf("}", braceStart);
        const inside = clause.slice(braceStart + 1, braceEnd < 0 ? undefined : braceEnd);
        for (const raw of inside.split(",")) {
          const name = raw.trim();
          if (!name || /\bas\b/.test(name) || name.startsWith("type ")) continue;
          if (/^[A-Za-z_$][\w$]*$/.test(name)) add(named, name, spec);
        }
      }

      // Leading default binding: identifier before any `{` or `*`.
      const head = (braceStart >= 0 ? clause.slice(0, braceStart) : clause).replace(/,\s*$/, "").trim();
      if (head && !head.startsWith("*") && /^[A-Za-z_$][\w$]*$/.test(head) && head !== "type") {
        add(defaults, head, spec);
      }
    }
  }
  return { named, defaults };
}

/** Where a symbol surfaces in the DS export graph for one file. */
export interface DsExportSite {
  rel: string;
  kind: "named" | "default";
}

/**
 * Two-tier index of the DS-tree export surface: for each symbol, the file(s)
 * that **define** it versus the file(s) that merely **re-export** it. A symbol
 * is *defined* by a file when that file declares the binding and exports it —
 * whether inline (`export function X`) or via a trailing local export list
 * (`function X(){}; … export { X }`, the shadcn/base-ui idiom the DS uses
 * heavily). A symbol is *re-exported* when a file forwards a binding it imported
 * (`export { X } from "…"`, or `import { X } … ; export { X }`) — e.g.
 * `design-system/utils/utils.ts` re-exporting `cn`.
 *
 * Splitting the two lets resolution prefer the owning module and fall back to a
 * unique re-export, while barrels (`index.*`) are excluded whole so a symbol
 * never resolves to a catch-all forwarder. `export *` is unenumerable and
 * contributes nothing. Pure: AST-only, no disk.
 */
export function indexDsExports(
  files: Array<{ rel: string; source: string }>,
): Map<string, { defs: DsExportSite[]; reexports: DsExportSite[] }> {
  const out = new Map<string, { defs: DsExportSite[]; reexports: DsExportSite[] }>();
  const add = (bucket: "defs" | "reexports", symbol: string, site: DsExportSite): void => {
    const entry = out.get(symbol) ?? { defs: [], reexports: [] };
    if (!entry[bucket].some(s => s.rel === site.rel)) entry[bucket].push(site);
    out.set(symbol, entry);
  };

  for (const { rel, source } of files) {
    const base = rel.split(/[\\/]/).pop() ?? rel;
    if (/^index\.[tj]sx?$/.test(base)) continue; // barrel — forwards only
    const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    // First pass: what this file declares locally vs imports, plus inline exports.
    const localDecls = new Set<string>();
    const imported = new Set<string>();
    const exportLists: ts.ExportDeclaration[] = [];
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && stmt.importClause) {
        const c = stmt.importClause;
        if (c.name) imported.add(c.name.text);
        if (c.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) imported.add(c.namedBindings.name.text);
          else for (const el of c.namedBindings.elements) imported.add(el.name.text);
        }
        continue;
      }
      if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        exportLists.push(stmt);
        continue;
      }
      const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
      const exported = mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      const kind = mods?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? "default" : "named";
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        localDecls.add(stmt.name.text);
        if (exported) add("defs", stmt.name.text, { rel, kind });
      } else if (ts.isClassDeclaration(stmt) && stmt.name) {
        localDecls.add(stmt.name.text);
        if (exported) add("defs", stmt.name.text, { rel, kind });
      } else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          localDecls.add(d.name.text);
          if (exported) add("defs", d.name.text, { rel, kind: "named" });
        }
      }
    }

    // Second pass: classify each named export-list entry now that locals are known.
    for (const stmt of exportLists) {
      const fromModule = stmt.moduleSpecifier !== undefined;
      for (const el of (stmt.exportClause as ts.NamedExports).elements) {
        const name = el.propertyName?.text ?? el.name.text; // the source binding's name
        const exportedAs = el.name.text;
        if (!fromModule && localDecls.has(name)) add("defs", exportedAs, { rel, kind: "named" });
        else if (fromModule || imported.has(name)) add("reexports", exportedAs, { rel, kind: "named" });
      }
    }
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Map a DS file (cwd-relative) to the canonical alias specifier to import it by,
 * using the consumer's tsconfig `paths`. When several alias prefixes map to the
 * same file (`@ds/*` and `@/design-system/*` both → `design-system/*`), the one
 * used most across the consumer's existing imports wins — the project's dominant
 * spelling — with shortest prefix then alphabetical as deterministic tiebreaks.
 * Returns `null` when no alias maps the file (no safe specifier to emit).
 */
function aliasSpecifierFor(
  rel: string,
  paths: Record<string, string[]>,
  prefixUsage: Map<string, number>,
): string | null {
  const noExt = rel.replace(/\\/g, "/").replace(/\.[tj]sx?$/, "");
  const candidates: Array<{ specifier: string; prefix: string }> = [];
  for (const [key, vals] of Object.entries(paths)) {
    if (!key.endsWith("/*") || !Array.isArray(vals)) continue;
    const prefix = key.slice(0, -2);
    if (!prefix) continue;
    for (const v of vals) {
      const target = String(v).replace(/^\.\//, "").replace(/\/\*$/, "");
      if (!target) continue;
      if (noExt === target || noExt.startsWith(target + "/")) {
        candidates.push({ specifier: prefix + noExt.slice(target.length), prefix });
        break;
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) =>
      (prefixUsage.get(b.prefix) ?? 0) - (prefixUsage.get(a.prefix) ?? 0) ||
      a.prefix.length - b.prefix.length ||
      a.prefix.localeCompare(b.prefix),
  );
  return candidates[0].specifier;
}

/**
 * Assemble a `RepairEnv` for one consumer project. Resolution is tiered, first
 * unique hit wins, decline (`null`) otherwise — evidence, never a guess:
 *
 *   1. **Sibling DS definition** — a single DS-tree file *defines* the symbol →
 *      import it by its canonical DS alias. Heals the cross-atom misses
 *      (`Button`, `Tooltip`, `Progress`, `Avatar`, …), including the
 *      declare-locally-then-`export { … }` idiom the DS uses.
 *   2. **Sole DS re-export** — no DS file defines it, but exactly one non-barrel
 *      DS file forwards it (`export { cn } from "@/lib/utils"`) → import by that
 *      file's canonical alias. The DS's own intended specifier for `cn`.
 *   3. **Existing import graph** — exactly one specifier across the project
 *      already imports a binding of that name (covers package symbols and any
 *      DS file with no alias). Named wins over default.
 *
 * A symbol that is ambiguous or absent at every tier returns `null`, leaving the
 * `UNRESOLVED-SYMBOL` finding to flag it (e.g. a parent-local helper no module
 * exports — the calendar-atom case).
 */
export async function buildRepairEnv(opts: RepairEnvOptions): Promise<RepairEnv> {
  const selfAbs = join(opts.cwd, opts.fileName);
  const collected: Array<{ rel: string; source: string }> = [];
  for (const d of SCAN_DIRS) {
    for (const f of await walk(join(opts.cwd, d))) {
      const rel = relative(opts.cwd, f);
      if (rel === opts.fileName || f === selfAbs) continue;
      try {
        collected.push({ rel, source: await readFile(f, "utf8") });
      } catch {
        /* unreadable file — skip */
      }
    }
  }

  const sources = collected.map(c => c.source);
  const { named, defaults } = indexImportGraph(sources);

  const dsPrefix = "design-system" + sep;
  const dsFiles = collected.filter(c => c.rel.startsWith(dsPrefix) || c.rel.startsWith("design-system/"));
  const dsExports = indexDsExports(dsFiles);

  const paths = await detectTsconfigPaths(opts.cwd, opts.srcRoot ?? "");
  const prefixUsage = new Map<string, number>();
  const allText = sources.join("\n");
  for (const key of Object.keys(paths)) {
    if (!key.endsWith("/*")) continue;
    const prefix = key.slice(0, -2);
    if (!prefix) continue;
    const re = new RegExp(`["']${escapeRegExp(prefix)}/`, "g");
    prefixUsage.set(prefix, allText.match(re)?.length ?? 0);
  }

  const fromDsSite = (site: DsExportSite): SymbolSource | null => {
    const spec = aliasSpecifierFor(site.rel, paths, prefixUsage);
    return spec ? { specifier: spec, kind: site.kind } : null;
  };

  return {
    resolve(symbol: string): SymbolSource | null {
      const ds = dsExports.get(symbol);
      // Tier 1: a single DS file owns (defines) the symbol.
      if (ds?.defs.length === 1) {
        const hit = fromDsSite(ds.defs[0]);
        if (hit) return hit;
      }
      // Tier 2: nothing defines it, but exactly one non-barrel DS file forwards it.
      if (ds && ds.defs.length === 0 && ds.reexports.length === 1) {
        const hit = fromDsSite(ds.reexports[0]);
        if (hit) return hit;
      }
      // Tier 3: a uniquely-resolving specifier already in the project's imports.
      const n = named.get(symbol);
      if (n && n.size === 1) return { specifier: [...n][0], kind: "named" };
      const d = defaults.get(symbol);
      if (d && d.size === 1) return { specifier: [...d][0], kind: "default" };
      return null;
    },
  };
}
