import { spawnSync } from "node:child_process";

/**
 * Shared clean-tree guard (PRD #325 / sub-issue #328).
 *
 * The pre-existing dirty-working-tree check that `migrate-layout` and
 * `reconform` hand-rolled has been extracted into this single utility.
 * Every destructive command runs it before any Decision resolution so a
 * clean-tree failure short-circuits before the user (or agent) is asked
 * anything — the historical "write-mixed-with-uncommitted-work" risk that
 * git history is designed to defend against.
 *
 * Contract:
 *   - No git repo → ok. The guard cannot check; commands that strictly
 *     require git (today: `migrate-layout`) keep their own pre-check.
 *   - Clean working tree → ok.
 *   - Dirty working tree → fail with a named, plain-language message that
 *     identifies the command and the `--allow-dirty` escape hatch (ADR-0016
 *     fail-loud: never silently continue past a refusal).
 *   - `allowDirty: true` → ok. The caller's authorized override; the
 *     historical "I know what I'm doing" path the issue preserves.
 */

export interface CleanTreeOptions {
  /** Command name embedded in the message — so the operator knows which gate refused. */
  command: string;
  /** Bypass — when true the guard returns ok even on a dirty tree. */
  allowDirty?: boolean;
  cwd: string;
}

export type CleanTreeResult =
  | { ok: true }
  | { ok: false; message: string };

export function checkCleanTree(opts: CleanTreeOptions): CleanTreeResult {
  if (opts.allowDirty) return { ok: true };

  const isRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: opts.cwd,
    stdio: "ignore",
  });
  if (isRepo.status !== 0) return { ok: true };

  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: opts.cwd,
    encoding: "utf8",
  });
  if (status.status !== 0) return { ok: true };
  if ((status.stdout ?? "").trim() === "") return { ok: true };

  return {
    ok: false,
    message:
      `${opts.command}: working tree is dirty — commit or stash changes first ` +
      `(or pass --allow-dirty to override).`,
  };
}
