import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../../../operation.js";
import type { ProjectContext } from "../../../project.js";

const DEST = "design-system/utils/portal-scope.module.css";

export const managePortalScope: Operation = {
  name: "manage-portal-scope@v0.9.0",
  async plan(ctx: ProjectContext): Promise<Change[]> {
    const upstream = await readFile(
      join(ctx.packDir, "files", DEST),
      "utf8",
    );
    const current = (await ctx.exists(DEST))
      ? await readFile(join(ctx.cwd, DEST), "utf8")
      : null;
    if (current === upstream) return [];
    return [
      {
        kind: "write",
        path: DEST,
        before: current !== null ? Buffer.from(current, "utf8") : null,
        after: Buffer.from(upstream, "utf8"),
      },
    ];
  },
};
