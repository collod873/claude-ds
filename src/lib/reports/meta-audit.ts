import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { info } from "../log.js";

const SCAN_DIRS = ["design-system/atoms", "design-system/composites", "design-system/patterns"];
const COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx"];
const SKIP_PATTERNS = [/^index\.ts$/, /\.logic\.ts$/, /\.d\.ts$/];
const META_RE = /export\s+const\s+meta\b/;

/**
 * Scan `design-system/{atoms,composites,references}` for `.tsx` files missing
 * `export const meta`. Returns a list of project-relative paths and emits one
 * info line per finding (prefixed `[dry-run]` when in dry-run mode).
 *
 * Pure reporting: no writes. The backfillMeta Op uses its own scan to plan the
 * actual fix; this helper exists so reconform can print the missing-meta tally
 * before deciding whether to run the Op.
 */
export async function findMissingMeta(cwd: string, dryRun: boolean): Promise<string[]> {
  const missing: string[] = [];
  for (const scanRel of SCAN_DIRS) {
    const scanAbs = join(cwd, scanRel);
    let entries: string[];
    try {
      entries = await readdir(scanAbs);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === ".keep" || entry === ".gitkeep") continue;
      if (!entry.endsWith(".tsx")) continue;
      if (COMPANION_SUFFIXES.some(s => entry.endsWith(s))) continue;
      if (SKIP_PATTERNS.some(re => re.test(entry))) continue;
      const entryPath = join(scanAbs, entry);
      const entryStat = await stat(entryPath).catch(() => null);
      if (!entryStat || !entryStat.isFile()) continue;
      let source: string;
      try {
        source = await readFile(entryPath, "utf8");
      } catch {
        continue;
      }
      if (META_RE.test(source)) continue;
      const relPath = join(scanRel, entry);
      missing.push(relPath);
      info(`${dryRun ? "[dry-run] " : ""}META-001: missing meta export: ${relPath}`);
    }
  }
  return missing;
}
