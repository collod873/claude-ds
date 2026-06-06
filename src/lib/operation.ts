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
  | { kind: "write"; path: string; before: Buffer | null; after: Buffer; mode?: "executable"; note?: Record<string, unknown> }
  | { kind: "delete"; path: string; before: Buffer }
  | { kind: "rename"; path: string; after: string }
  | { kind: "abort"; path: string; reason: string };

/**
 * The dual return shape of `plan()`. `changes` is the byte-level plan the Runner
 * applies. `outcome` is the typed non-byte fact (a fixer's `FixResult`, a list of
 * GEN-001 violations, sync's per-file verdict rows) that downstream commands need
 * to render their scorecards and previews. The Runner threads `outcome` through
 * `RunReport.ops[i].outcome` so consumers never reach back through a side-channel
 * on the Op handle.
 */
export interface PlanResult<TOutcome = void> {
  changes: Change[];
  outcome: TOutcome;
}

/**
 * The shape of `plan()`'s return. Byte-only Ops (the default `Operation<void>`)
 * stay zero-touch — they keep returning `Change[]` directly. Ops that produce a
 * non-byte outcome declare it via `Operation<TOutcome>` and return the explicit
 * `{ changes, outcome }` shape so TypeScript can enforce that `outcome` is set.
 */
export type PlanReturn<TOutcome> = [TOutcome] extends [void]
  ? Change[]
  : PlanResult<TOutcome>;

/**
 * A planned mutation phase. `plan()` reads the filesystem through `ctx` and
 * returns the Changes it would make — it must not write to disk itself. The
 * Runner is the single chokepoint for bytes.
 *
 * Generic `TOutcome` (default `void`) is the type of the non-byte fact this Op
 * produces — fixer pass/fail+message, structural-decision summaries (extracted
 * components, per-file sync verdicts), violation lists. The Runner reports it
 * via `RunReport.ops[i].outcome`. Byte-only Ops use the default `void` and
 * return `Change[]` directly.
 */
export interface Operation<TOutcome = void> {
  name: string;
  plan(ctx: ProjectContext): Promise<PlanReturn<TOutcome>>;
}
