import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";

/**
 * Deletes a set of files (deprecated orphans, root-dupe copies, CLAUDE.md collision
 * files). `relPaths` are relative to `ctx.cwd`. Files absent at plan time are
 * silently skipped; ENOENT during apply is swallowed by the Runner.
 */
export function makeDeleteFiles(relPaths: string[]): Operation {
  return {
    name: "reconcile-delete",
    async plan(ctx: ProjectContext): Promise<Change[]> {
      const changes: Change[] = [];
      for (const p of relPaths) {
        const abs = join(ctx.cwd, p);
        let before: Buffer;
        try {
          before = await readFile(abs);
        } catch (e: any) {
          if (e.code === "ENOENT") continue;
          throw e;
        }
        changes.push({ kind: "delete", path: p, before });
      }
      return changes;
    },
  };
}

/**
 * Merges a root file's content into its canonical counterpart, then deletes the
 * root. Emits a `write` Change (canonical update) followed by a `delete` Change
 * (root removal) so the Runner applies them atomically through its chokepoint.
 */
export function makeMergeRootToCanonical(rootPath: string, canonicalPath: string): Operation {
  return {
    name: "reconcile-merge",
    async plan(ctx: ProjectContext): Promise<Change[]> {
      const rootAbs = join(ctx.cwd, rootPath);
      const canonicalAbs = join(ctx.cwd, canonicalPath);
      const rootContent = await readFile(rootAbs);
      let canonicalBefore: Buffer | null;
      try {
        canonicalBefore = await readFile(canonicalAbs);
      } catch (e: any) {
        if (e.code === "ENOENT") canonicalBefore = null;
        else throw e;
      }
      return [
        { kind: "write", path: canonicalPath, before: canonicalBefore, after: rootContent },
        { kind: "delete", path: rootPath, before: rootContent },
      ];
    },
  };
}
