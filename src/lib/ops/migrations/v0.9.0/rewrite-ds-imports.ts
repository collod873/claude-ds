import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../../../operation.js";
import type { ProjectContext } from "../../../project.js";

const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

// Rewrite: from "@/design-system/X" → from "@ds/X"
const ALIAS_IMPORT_RE = /(from\s+["'])@\/design-system\/(.*?)(["'])/g;

// Rewrite: from "./design-system/X" or from "../../design-system/X" → from "@ds/X"
// Requires at least one leading ./ or ../ to avoid matching bare package names.
const RELATIVE_IMPORT_RE = /(from\s+["'])(?:\.\.?\/)+design-system\/(.*?)(["'])/g;

/**
 * Migration Op for v0.9.0: rewrite design-system import paths to the @ds/* alias.
 *
 * Handles both `@/design-system/*` and relative paths (`../../design-system/*`).
 * Walks all .ts/.tsx/.js/.jsx files under cwd, skipping node_modules, .git, dist.
 *
 * Reuses the same file-walking and substitution pattern as the rewriteImports Op
 * (no new import-rewriter infrastructure).
 *
 * Idempotent: files that already use @ds/* are not modified.
 */
export const rewriteDsImports: Operation = {
  name: "rewrite-ds-imports@v0.9.0",
  async plan(ctx: ProjectContext): Promise<Change[]> {
    const changes: Change[] = [];

    async function walk(absDir: string, relDir: string): Promise<void> {
      let entries: string[];
      try {
        entries = await readdir(absDir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue;
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

        // Apply both rewrites. Order matters: alias first so relative re-match is impossible.
        let updated = content.replace(ALIAS_IMPORT_RE, "$1@ds/$2$3");
        updated = updated.replace(RELATIVE_IMPORT_RE, "$1@ds/$2$3");

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
