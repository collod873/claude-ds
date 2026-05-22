import type { ProjectContext } from "./project.js";

/**
 * The unit of work an Operation emits. Bytes-on-disk only — non-file effects
 * (registering an exception, recording a canonical path) must be modelled as a
 * write to the file that holds them.
 *
 * `path` (and `after` on rename) are interpreted relative to `ctx.cwd` by the Runner.
 *
 * `abort` is the "I planned to touch this file but the user's state forbids it" signal —
 * mostly emitted by sync when a managed file has been hand-edited. The Runner logs it
 * in dry-run and skips it (no write, no failure) in apply, so one file's abort cannot
 * stop the rest of the plan from applying. Lives in Change so it surfaces in RunReport
 * the same way as any other planned outcome.
 */
export type Change =
  | { kind: "write"; path: string; before: Buffer | null; after: Buffer; note?: Record<string, unknown> }
  | { kind: "delete"; path: string; before: Buffer }
  | { kind: "rename"; path: string; after: string }
  | { kind: "abort"; path: string; reason: string };

/**
 * A planned mutation phase. `plan()` reads the filesystem through `ctx` and
 * returns the Changes it would make — it must not write to disk itself. The
 * Runner is the single chokepoint for bytes.
 */
export interface Operation {
  name: string;
  plan(ctx: ProjectContext): Promise<Change[]>;
}
