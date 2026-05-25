import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Detect DS path aliases from tsconfig.json compilerOptions.paths.
 * Returns alias prefixes (e.g. ["@ds"]) whose values resolve to design-system/.
 *
 * Checks {srcRoot}/tsconfig.json first, falls back to cwd root.
 */
export async function detectDsAliases(cwd: string, srcRoot: string): Promise<string[]> {
  const candidates = [join(cwd, srcRoot, "tsconfig.json"), join(cwd, "tsconfig.json")];
  for (const tsconfigPath of candidates) {
    let raw: string;
    try {
      raw = await readFile(tsconfigPath, "utf8");
    } catch {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const compilerOptions = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
    const paths = (compilerOptions.paths ?? {}) as Record<string, string[]>;

    const aliases: string[] = [];
    for (const [key, values] of Object.entries(paths)) {
      if (!key.endsWith("/*")) continue;
      if (!Array.isArray(values)) continue;
      const pointsToDs = values.some(v => /(?:^|[./])design-system\/\*$/.test(v));
      if (!pointsToDs) continue;
      const prefix = key.slice(0, -2);
      if (prefix.length > 0) aliases.push(prefix);
    }
    return aliases;
  }
  return [];
}
