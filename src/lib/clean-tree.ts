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
 *     identifies the command and the `--allow-dirty` escape hatch (ADR-0023
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

/**
 * Why the guard let the command through — retained as run metadata so a later
 * failure report can state whether an automatic revert is possible (PRD #575 /
 * sub-issue #580). The gate decision used to collapse all three "ok" paths into
 * a bare `true`; heal needs to tell them apart at exit:
 *   - `clean` — the tree was clean at start, so every byte the command wrote is
 *     uncommitted and `git` can undo all of it. The report prints the exact
 *     revert command.
 *   - `dirty-overridden` — `--allow-dirty` bypassed the gate, so the command's
 *     writes are mixed with pre-existing uncommitted work `git` can't separate.
 *     No automatic revert; the report falls back to the inventory.
 *   - `no-git` — not a git repo (or `git status` failed), so there is no
 *     transaction layer to undo from. Same fallback.
 */
export type CleanTreeState = "clean" | "dirty-overridden" | "no-git";

export type CleanTreeResult = { ok: true; state: CleanTreeState } | { ok: false; message: string };

export function checkCleanTree(opts: CleanTreeOptions): CleanTreeResult {
	// `--allow-dirty` bypasses the git probe entirely, so we can't know whether the
	// tree was clean — treat it as dirty-overridden: the conservative state that
	// withholds the automatic-revert offer.
	if (opts.allowDirty) return { ok: true, state: "dirty-overridden" };

	const isRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd: opts.cwd,
		stdio: "ignore",
	});
	if (isRepo.status !== 0) return { ok: true, state: "no-git" };

	const status = spawnSync("git", ["status", "--porcelain"], {
		cwd: opts.cwd,
		encoding: "utf8",
	});
	// A repo whose `git status` failed gives us no transaction layer to undo from —
	// same fallback as no-git.
	if (status.status !== 0) return { ok: true, state: "no-git" };
	if ((status.stdout ?? "").trim() === "") return { ok: true, state: "clean" };

	return {
		ok: false,
		message:
			`${opts.command}: working tree is dirty — commit or stash changes first ` +
			`(or pass --allow-dirty to override).`,
	};
}
