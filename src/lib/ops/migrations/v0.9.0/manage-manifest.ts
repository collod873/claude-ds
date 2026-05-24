import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../../../operation.js";
import type { ProjectContext } from "../../../project.js";

const SCRIPT_PATH = "scripts/build-manifest.ts";
const GENERATED_PATH = "design-system/manifest.generated.ts";

/**
 * manage-manifest@v0.9.0
 *
 * Graduates the manifest generator to a managed pack file:
 * 1. Installs (or updates) scripts/build-manifest.ts from the pack.
 * 2. Deletes the consumer's hand-built design-system/manifest.generated.ts so
 *    the regenerated output from the script takes over cleanly.
 *
 * The PostToolUse hook (regenerate-companions.sh step 4) runs build-manifest.ts
 * on every relevant tsx write, so the generated file is immediately recreated
 * after the migration applies.
 */
export const manageManifestMigration: Operation = {
  name: "manage-manifest@v0.9.0",
  async plan(ctx: ProjectContext): Promise<Change[]> {
    const changes: Change[] = [];

    const packContent = await readFile(
      join(ctx.packDir, "files", SCRIPT_PATH),
      "utf8",
    );
    const currentScript = (await ctx.exists(SCRIPT_PATH))
      ? await readFile(join(ctx.cwd, SCRIPT_PATH), "utf8")
      : null;

    if (currentScript !== packContent) {
      changes.push({
        kind: "write",
        path: SCRIPT_PATH,
        before: currentScript === null ? null : Buffer.from(currentScript, "utf8"),
        after: Buffer.from(packContent, "utf8"),
      });
    }

    if (await ctx.exists(GENERATED_PATH)) {
      const before = await readFile(join(ctx.cwd, GENERATED_PATH));
      changes.push({ kind: "delete", path: GENERATED_PATH, before });
    }

    return changes;
  },
};
