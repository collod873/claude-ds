import { analyzeResolution } from "./resolve-symbols.js";

/**
 * A proven origin for a single unbound symbol: the module specifier to import
 * it from and whether it is a named or default export. Returned by a
 * `RepairEnv` only when the origin is *unique and proven* — never a guess.
 */
export interface SymbolSource {
  specifier: string;
  kind: "named" | "default";
}

/**
 * The resolution environment a repair runs against. `resolve` maps one unbound
 * value symbol to its proven source, or `null` when no source — or more than
 * one — can be proven. This is the seam where #260's "evidence, not heuristic"
 * rule lives: the repairer adds an import only for symbols this returns a
 * source for, and leaves every `null` in `remaining` so the finding persists.
 *
 * Keeping it an injected interface (not baked-in disk access) makes the repair
 * logic pure and unit-testable without a filesystem, mirroring how
 * `analyzeResolution` stays a pure single-file pass.
 */
export interface RepairEnv {
  resolve(symbol: string): SymbolSource | null;
}

/**
 * Outcome of a repair pass over one file.
 *
 * `source` — the (possibly rewritten) file text. Equal to the input when
 * nothing was provably repaired.
 * `repaired` — true iff at least one import was added.
 * `remaining` — unbound symbols left unresolved; the `UNRESOLVED-SYMBOL`
 * finding must persist for these. Honest partial repair: fix what's proven,
 * flag the rest.
 */
export interface RepairResult {
  source: string;
  repaired: boolean;
  remaining: string[];
}

/**
 * Re-derive the missing import closure for a corrupt tier file, adding an
 * import only for each unbound symbol whose origin the `RepairEnv` can prove
 * uniquely. Symbols it cannot prove are returned in `remaining`, never guessed
 * — a wrong import would compile-then-break a consumer, against the north star.
 */
export function repairUnresolvedSymbols(
  source: string,
  fileName: string,
  env: RepairEnv,
): RepairResult {
  const { unresolved, typeOnlySymbols } = analyzeResolution(source, fileName);

  const remaining: string[] = [];
  const named = new Map<string, Set<string>>(); // specifier → named value symbols
  const namedTypeOnly = new Map<string, Set<string>>(); // specifier → type-only symbols
  const defaults: Array<{ symbol: string; specifier: string }> = [];

  for (const symbol of unresolved) {
    const found = env.resolve(symbol);
    if (!found) {
      remaining.push(symbol);
      continue;
    }
    if (found.kind === "default") {
      defaults.push({ symbol, specifier: found.specifier });
    } else if (typeOnlySymbols.has(symbol)) {
      // Symbol appears only in type position: emit `import type { X }` so the
      // import is safe for consumers with `isolatedModules` / `verbatimModuleSyntax`
      // and for packages that export the symbol as a type-only export.
      const set = namedTypeOnly.get(found.specifier) ?? new Set<string>();
      set.add(symbol);
      namedTypeOnly.set(found.specifier, set);
    } else {
      const set = named.get(found.specifier) ?? new Set<string>();
      set.add(symbol);
      named.set(found.specifier, set);
    }
  }

  if (named.size === 0 && namedTypeOnly.size === 0 && defaults.length === 0) {
    return { source, repaired: false, remaining };
  }

  const lines: string[] = [];
  for (const { symbol, specifier } of defaults) {
    lines.push(`import ${symbol} from "${specifier}";`);
  }
  for (const [specifier, symbols] of [...named.entries()].sort()) {
    const names = [...symbols].sort().join(", ");
    lines.push(`import { ${names} } from "${specifier}";`);
  }
  for (const [specifier, symbols] of [...namedTypeOnly.entries()].sort()) {
    const names = [...symbols].sort().join(", ");
    lines.push(`import type { ${names} } from "${specifier}";`);
  }

  return { source: insertImports(source, lines), repaired: true, remaining };
}

/**
 * Insert import statements at the top of the file, after a leading
 * `"use client"` / `"use server"` directive if one is present (a directive must
 * stay the first statement). Idempotent ordering is the caller's concern.
 */
function insertImports(source: string, importLines: string[]): string {
  const block = importLines.join("\n") + "\n";
  const directive = /^(\s*(?:"use (?:client|server)"|'use (?:client|server)');?[ \t]*\r?\n)/;
  const m = source.match(directive);
  if (m) {
    const at = m[0].length;
    return source.slice(0, at) + block + source.slice(at);
  }
  return block + source;
}
