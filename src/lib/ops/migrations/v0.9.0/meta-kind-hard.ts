import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../../../operation.js";
import type { ProjectContext } from "../../../project.js";

/**
 * Migration Op for v0.9.0: flip meta.kind from soft-warn to hard-required.
 *
 * Sets `meta_kind_strict: true` in `.claude-ds.json`, which causes the audit
 * command to emit DRIFT-META-KIND-MISSING (exit 1) for any DS file that lacks
 * a `meta.kind` declaration. Run this after `classify` has guaranteed that
 * every component under design-system/ carries a meta.kind stub.
 *
 * Idempotent: if `meta_kind_strict` is already true the Op returns no changes.
 */
export const metaKindHardMigration: Operation = {
  name: "meta-kind-hard@v0.9.0",
  async plan(ctx: ProjectContext): Promise<Change[]> {
    const cfgRel = ".claude-ds.json";
    const cfgAbs = join(ctx.cwd, cfgRel);
    let raw: string;
    try {
      raw = await readFile(cfgAbs, "utf8");
    } catch {
      return [];
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (obj.meta_kind_strict === true) return [];
    const updated = { ...obj, meta_kind_strict: true };
    return [
      {
        kind: "write",
        path: cfgRel,
        before: Buffer.from(raw, "utf8"),
        after: Buffer.from(JSON.stringify(updated, null, 2) + "\n", "utf8"),
      },
    ];
  },
};
