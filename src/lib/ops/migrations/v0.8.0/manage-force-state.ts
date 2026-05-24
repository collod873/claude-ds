import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../../../operation.js";
import type { ProjectContext } from "../../../project.js";

const FILE_PATH = "design-system/utils/force-state.css";

export const manageForceState: Operation = {
  name: "manage-force-state@v0.8.0",
  async plan(ctx: ProjectContext): Promise<Change[]> {
    const upstream = await readFile(join(ctx.packDir, "files", FILE_PATH), "utf8");
    const current = (await ctx.exists(FILE_PATH))
      ? await readFile(join(ctx.cwd, FILE_PATH), "utf8")
      : null;

    if (current === upstream) return [];

    return [{
      kind: "write",
      path: FILE_PATH,
      before: current === null ? null : Buffer.from(current, "utf8"),
      after: Buffer.from(upstream, "utf8"),
    }];
  },
};
