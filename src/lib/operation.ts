import type { ProjectContext } from "./project.js";

/**
 * The unit of work an Operation emits. Bytes-on-disk only — non-file effects
 * (registering an exception, recording a canonical path) must be modelled as a
 * write to the file that holds them.
 *
 * `path` (and `after` on rename) are interpreted relative to `ctx.cwd` by the Runner.
 */
export type Change =
  | { kind: "write"; path: string; before: Buffer | null; after: Buffer }
  | { kind: "delete"; path: string; before: Buffer }
  | { kind: "rename"; path: string; after: string };

/**
 * A planned mutation phase. `plan()` reads the filesystem through `ctx` and
 * returns the Changes it would make — it must not write to disk itself. The
 * Runner is the single chokepoint for bytes.
 */
export interface Operation {
  name: string;
  plan(ctx: ProjectContext): Promise<Change[]>;
}
