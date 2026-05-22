import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";

/**
 * Match `from "...@/design-system/<tier>/..."` — but exclude `types/meta`. The
 * `Meta` type import is structural, not a real DS-module dependency, and would
 * otherwise promote every atom to composite the moment we backfill meta.
 */
const DS_IMPORT_RE = /from\s+["'][^"']*@\/design-system\/(?!types\/meta)/;

export function fileImportsDsModule(source: string): boolean {
  return DS_IMPORT_RE.test(source);
}

/**
 * Project-wide path substitution: rewrite every occurrence of `from` to `to`
 * in `.ts`/`.tsx`/`.js`/`.jsx` files under `projectRoot`, skipping
 * `node_modules` and `.git`. Mutates the filesystem in place — used by
 * reconform's inline classification auto-move (still inline pending #83).
 *
 * Returns the list of touched files for the caller to log. Kept exported for
 * back-compat with reconform's current behaviour; `rewriteImports.plan()`
 * achieves the same end-state through the Runner.
 */
export async function rewriteImportPaths(
  projectRoot: string,
  from: string,
  to: string,
): Promise<string[]> {
  // from/to are like "atoms/button" or "composites/button"
  const fromPath = `@/design-system/${from}`;
  const toPath = `@/design-system/${to}`;
  const { writeFile } = await import("node:fs/promises");
  const changed: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      const s = await stat(full).catch(() => null);
      if (!s) continue;
      if (s.isDirectory()) {
        if (entry === "node_modules" || entry === ".git") continue;
        await walk(full);
      } else if (s.isFile() && (entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".js") || entry.endsWith(".jsx"))) {
        let content: string;
        try { content = await readFile(full, "utf8"); } catch { continue; }
        if (content.includes(fromPath)) {
          const updated = content.split(fromPath).join(toPath);
          await writeFile(full, updated, "utf8");
          changed.push(full);
        }
      }
    }
  }

  await walk(projectRoot);
  return changed;
}

const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx"];
const TIER_PAIR: Array<{ from: "atoms" | "composites"; to: "atoms" | "composites" }> = [
  { from: "atoms",      to: "composites" },
  { from: "composites", to: "atoms" },
];

async function listTier(ctx: ProjectContext, tier: "atoms" | "composites"): Promise<Set<string>> {
  const dirRel = `design-system/${tier}`;
  if (!(await ctx.exists(dirRel))) return new Set();
  let entries: string[];
  try {
    entries = await readdir(join(ctx.cwd, dirRel));
  } catch {
    return new Set();
  }
  const out = new Set<string>();
  for (const entry of entries) {
    if (!entry.endsWith(".tsx")) continue;
    // Drop companions; the tier "membership" key is the component's basename.
    if (/\.(showcase|states|test|stories)\.[a-z]+$/.test(entry)) continue;
    out.add(entry.slice(0, -4));
  }
  return out;
}

/**
 * Plan tier-relocation import rewrites across the project.
 *
 * Background: `reconform` (inline pending #83) may move a component between
 * `design-system/atoms/` and `design-system/composites/` based on classification
 * findings. When that move happens via `git mv` (or `rename`), the import sites
 * scattered across the project still reference the old tier. This Op closes
 * that gap by emitting `write` Changes for each consumer file whose imports
 * point at the wrong tier — i.e. `@/design-system/atoms/X` where `X.tsx` now
 * lives under `composites/` (and vice versa).
 *
 * Idempotent: in the steady state where every imported component still lives
 * in the tier it's referenced from, plan() returns `[]`.
 *
 * Scope: walks the project from `ctx.cwd`, skipping `node_modules`, `.git`,
 * and `dist`. Reads `.ts`/`.tsx`/`.js`/`.jsx` files only.
 */
export const rewriteImports: Operation = {
  name: "rewrite-imports",
  async plan(ctx: ProjectContext): Promise<Change[]> {
    const atoms = await listTier(ctx, "atoms");
    const composites = await listTier(ctx, "composites");
    if (atoms.size === 0 && composites.size === 0) return [];

    // Build substitution map: for each component, the wrong-tier import path
    // we should rewrite *to* the right-tier path.
    const subs: Array<{ wrong: string; right: string }> = [];
    for (const { from, to } of TIER_PAIR) {
      const wrongTier = from;
      const rightTier = to;
      const rightSet = rightTier === "atoms" ? atoms : composites;
      const wrongSet = wrongTier === "atoms" ? atoms : composites;
      // Component lives in rightTier but consumers might still reference wrongTier.
      for (const name of rightSet) {
        // Skip ambiguous cases where the same basename exists in both tiers —
        // the rewrite would be unsafe and the user must resolve manually.
        if (wrongSet.has(name)) continue;
        subs.push({
          wrong: `@/design-system/${wrongTier}/${name}`,
          right: `@/design-system/${rightTier}/${name}`,
        });
      }
    }
    if (subs.length === 0) return [];

    const changes: Change[] = [];
    async function walk(absDir: string, relDir: string): Promise<void> {
      let entries: string[];
      try {
        entries = await readdir(absDir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
        const absChild = join(absDir, entry);
        const relChild = relDir ? join(relDir, entry) : entry;
        const s = await stat(absChild).catch(() => null);
        if (!s) continue;
        if (s.isDirectory()) {
          await walk(absChild, relChild);
          continue;
        }
        if (!s.isFile()) continue;
        if (!SOURCE_EXTS.some(ext => entry.endsWith(ext))) continue;

        let content: string;
        try { content = await readFile(absChild, "utf8"); } catch { continue; }
        let updated = content;
        for (const { wrong, right } of subs) {
          if (updated.includes(wrong)) {
            // Word-boundary check: only rewrite when followed by `"`, `'`, or `/`.
            // Splitting on the literal substring with a lookahead-style guard
            // keeps this stable against substring collisions (e.g. `atoms/foo`
            // vs `atoms/foo-bar`).
            const re = new RegExp(escapeRegex(wrong) + `(?=["'\\\\/])`, "g");
            updated = updated.replace(re, right);
          }
        }
        if (updated !== content) {
          changes.push({
            kind: "write",
            path: relChild,
            before: Buffer.from(content, "utf8"),
            after: Buffer.from(updated, "utf8"),
          });
        }
      }
    }
    await walk(ctx.cwd, "");
    return changes;
  },
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
