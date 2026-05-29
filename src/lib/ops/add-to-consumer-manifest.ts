import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";

const CONSUMER_MANIFEST_PATH = "design-system/manifest.json";

/**
 * Adds `paths` as `seeded` entries to the consumer's `design-system/manifest.json`.
 * If the consumer manifest is absent, the pack manifest (`ctx.packDir/manifest.json`)
 * is used as the seed. Entries already present are skipped — emits no Change when
 * every path is already tracked.
 */
export function addToConsumerManifest(paths: string[]): Operation {
  return {
    name: "audit-add-consumer-manifest",
    async plan(ctx: ProjectContext): Promise<Change[]> {
      if (paths.length === 0) return [];

      const consumerAbs = join(ctx.cwd, CONSUMER_MANIFEST_PATH);
      let before: Buffer | null = null;
      let manifestJson: Record<string, unknown>;
      try {
        before = await readFile(consumerAbs);
        manifestJson = JSON.parse(before.toString("utf8"));
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw e;
        before = null;
        manifestJson = JSON.parse(await readFile(join(ctx.packDir, "manifest.json"), "utf8"));
      }

      const files = (manifestJson.files ?? []) as Array<{ path: string; category: string }>;
      const existing = new Set(files.map((f) => f.path));
      const toAdd = paths.filter((p) => !existing.has(p));
      if (toAdd.length === 0) return [];

      const nextFiles = [...files, ...toAdd.map((p) => ({ path: p, category: "seeded" }))];
      manifestJson.files = nextFiles;
      const after = Buffer.from(JSON.stringify(manifestJson, null, 2) + "\n", "utf8");
      if (before && before.equals(after)) return [];

      return [{ kind: "write", path: CONSUMER_MANIFEST_PATH, before, after }];
    },
  };
}
