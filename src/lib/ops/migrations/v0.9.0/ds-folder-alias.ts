import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Change, Operation } from "../../../operation.js";
import type { ProjectContext } from "../../../project.js";

/**
 * Migration Op for v0.9.0: hybrid-edit tsconfig.json to add the @ds/* path alias.
 *
 * Looks for tsconfig.json at {srcRoot}/tsconfig.json first, then at cwd root.
 * Adds `compilerOptions.paths["@ds/*"]` pointing at the relative path from
 * the tsconfig's directory to the repo-root design-system/ folder.
 *
 * Idempotent: no-op if @ds/* is already present.
 */
export const dsFolderAlias: Operation = {
  name: "ds-folder-alias@v0.9.0",
  async plan(ctx: ProjectContext): Promise<Change[]> {
    const srcRoot = ctx.cfg.srcRoot;

    // Find tsconfig.json: check {srcRoot}/tsconfig.json first, then cwd root.
    let tsconfigRel: string | null = null;
    const srcTsconfigRel = join(srcRoot, "tsconfig.json");
    if (await ctx.exists(srcTsconfigRel)) {
      tsconfigRel = srcTsconfigRel;
    } else if (await ctx.exists("tsconfig.json")) {
      tsconfigRel = "tsconfig.json";
    }
    if (!tsconfigRel) return [];

    const tsconfigAbs = join(ctx.cwd, tsconfigRel);
    let raw: string;
    try {
      raw = await readFile(tsconfigAbs, "utf8");
    } catch {
      return [];
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // tsconfig has comments or is otherwise unparseable — skip silently.
      return [];
    }

    const compilerOptions = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
    const paths = (compilerOptions.paths ?? {}) as Record<string, string[]>;

    if (paths["@ds/*"]) return [];

    // Compute relative path from tsconfig's directory to design-system/ at cwd root.
    const tsconfigDir = join(ctx.cwd, dirname(tsconfigRel));
    const dsDir = join(ctx.cwd, "design-system");
    const relPath = relative(tsconfigDir, dsDir);
    const mapping = (relPath.startsWith(".") ? relPath : "./" + relPath) + "/*";

    paths["@ds/*"] = [mapping];
    compilerOptions.paths = paths;
    parsed.compilerOptions = compilerOptions;

    const indent = detectIndent(raw);
    const after = JSON.stringify(parsed, null, indent) + "\n";

    return [{
      kind: "write",
      path: tsconfigRel,
      before: Buffer.from(raw, "utf8"),
      after: Buffer.from(after, "utf8"),
    }];
  },
};

function detectIndent(raw: string): number | string {
  const firstIndented = raw.split("\n").find(l => l.startsWith(" ") || l.startsWith("\t"));
  return firstIndented && firstIndented.startsWith("\t") ? "\t" : 2;
}
