import type { Change, Operation } from "../../../operation.js";
import type { ProjectContext } from "../../../project.js";

/**
 * No-op migration for v0.8.0. Produces zero Changes; exists to prove the
 * migration framework wiring end-to-end before real Ops land in later slices.
 */
export const noopMigration: Operation = {
  name: "noop@v0.8.0",
  async plan(_ctx: ProjectContext): Promise<Change[]> {
    return [];
  },
};
