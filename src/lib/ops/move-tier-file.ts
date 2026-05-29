import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";

export interface EnsureMeta {
  kind: "atom" | "composite";
}

const META_RE = /export\s+const\s+meta\b/;
const KIND_RE = /(\bkind\s*:\s*["'])(atom|composite)(["'])/;

function applyMeta(source: string, kind: "atom" | "composite"): string {
  if (META_RE.test(source)) {
    return source.replace(KIND_RE, `$1${kind}$3`);
  }
  const hasCva = source.includes("cva(");
  const stub = hasCva
    ? `export const meta = { kind: "${kind}", examples: [], skip: [] } as const;\n`
    : `export const meta = { kind: "${kind}", examples: [{ name: "default", props: {} }] } as const;\n`;
  const sep = source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
  return source + sep + stub;
}

/**
 * Moves a tier file from `srcRel` to `destRel` and, when `ensureMeta` is set,
 * guarantees the destination file exports `meta.kind = ensureMeta.kind` — either
 * by injecting a default stub (no existing meta export) or by flipping the kind
 * of an existing export. Both paths are relative to `ctx.cwd`.
 *
 * Emits a `rename` Change plus, when the meta update actually changes bytes, a
 * `write` Change at the destination path. The Runner's existing git-mv detection
 * replaces classify's old `git rev-parse` probe.
 */
export function moveTierFile(
  srcRel: string,
  destRel: string,
  ensureMeta?: EnsureMeta,
): Operation {
  return {
    name: "classify-move-tier-file",
    async plan(ctx: ProjectContext): Promise<Change[]> {
      const changes: Change[] = [
        { kind: "rename", path: srcRel, after: destRel },
      ];

      if (!ensureMeta) return changes;

      const source = await readFile(join(ctx.cwd, srcRel), "utf8");
      const updated = applyMeta(source, ensureMeta.kind);
      if (updated === source) return changes;

      changes.push({
        kind: "write",
        path: destRel,
        before: Buffer.from(source, "utf8"),
        after: Buffer.from(updated, "utf8"),
      });
      return changes;
    },
  };
}
