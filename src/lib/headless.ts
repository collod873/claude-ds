/**
 * Issue #408 / PRD #407 — the headless command contract.
 *
 * Every loop-critical command (`adopt`, `audit` [+ `--fix`], `heal`,
 * `sync`, `classify`, `upgrade`, `doctor`) must expose a machine-readable
 * surface a verifying agent that cannot see TTY can read: a documented
 * **exit code** plus a `--json` surface emitting one JSON document
 * (state → verdict → actions → remaining).
 *
 * This module centralises:
 *   - the `HeadlessResult` shape every command emits under `--json`,
 *   - the documented exit-code matrix (`HEADLESS_EXIT`),
 *   - `emitHeadless()` which serialises the result and exits with the
 *     declared code, and
 *   - `setJsonMode()` / `isJsonMode()` so the existing `info()` chatter
 *     inside command bodies is suppressed without touching every call
 *     site individually — keeps the JSON document the entirety of stdout.
 *
 * The exit-code matrix (per `HEADLESS_EXIT`):
 *
 *   0 — clean / converged / no work required.
 *   1 — findings remain / did not converge / exhausted.
 *   2 — user-input / environment error (no `.claude-ds.json`,
 *       bad flag, dirty tree without `--allow-dirty`, etc).
 *   3 — Pending Ambiguity decisions remain (heal-specific).
 *
 * The non-TTY byte stream is the assertion target for every UX-grammar test
 * (PRD #407 story 26): bytes are byte-identical to the TTY stream minus
 * color. `--json` is one step further — the byte stream is JSON only.
 */
import { setJsonMode } from "./log.js";

export const HEADLESS_EXIT = {
	OK: 0,
	FINDINGS: 1,
	USER_INPUT: 2,
	PENDING: 3,
} as const;

export type HeadlessExitCode = (typeof HEADLESS_EXIT)[keyof typeof HEADLESS_EXIT];

export type HeadlessCommand =
	| "adopt"
	| "audit"
	| "heal"
	| "sync"
	| "classify"
	| "upgrade"
	| "doctor";

/**
 * The shared JSON shape every loop-critical command emits under `--json`.
 *
 * - `command`: the command name (matches `claude-ds <command>`).
 * - `ok`: convenience boolean — equivalent to `exitCode === 0`. A `true`
 *   value means the command finished in a clean / converged / no-work
 *   state; the agent can route on `ok` without the exit-code lookup.
 * - `verdict`: a per-command human-readable label (clean / converged /
 *   adopted / findings / pending / error / …). Stable enough to assert in
 *   tests but not the source of truth — `exitCode` is.
 * - `exitCode`: mirrors the process exit code the runtime actually used.
 *   Pinned in the JSON so a caller that captured stdout but lost stderr /
 *   the exit code can still recover the outcome.
 * - `actions`: per-command record of what the command **did** this run
 *   (files written, moves applied, migrations run, etc). The agent uses
 *   this to confirm a step actually advanced the tree.
 * - `remaining`: per-command record of what's **left** (findings count,
 *   missing scaffold files, pending decisions). The agent uses this to
 *   decide whether another loop iteration is warranted.
 *
 * `actions` / `remaining` are deliberately typed as open `Record<string,
 * unknown>` so per-command shapes can extend without churning every
 * caller. Field names are documented per command in the comment above
 * each command's `--json` branch.
 */
export interface HeadlessResult {
	command: HeadlessCommand;
	ok: boolean;
	verdict: string;
	exitCode: number;
	actions: Record<string, unknown>;
	remaining: Record<string, unknown>;
}

/**
 * Serialise the result, write it as the entirety of stdout, and exit with
 * the declared code. Restores `jsonMode` before exiting so a re-entrant
 * test (running the CLI in-process via `runCli`) sees a clean state.
 */
export function emitHeadless(result: HeadlessResult): never {
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	setJsonMode(false);
	process.exit(result.exitCode);
}

/**
 * Build a uniformly-shaped error result for the user-input / env-error
 * (exit 2) path. Keeps every command's "no .claude-ds.json", "bad flag",
 * "dirty tree" branches emitting the same envelope.
 */
export function errorResult(
	command: HeadlessCommand,
	message: string,
	extra: Record<string, unknown> = {},
): HeadlessResult {
	return {
		command,
		ok: false,
		verdict: "error",
		exitCode: HEADLESS_EXIT.USER_INPUT,
		actions: {},
		remaining: { error: message, ...extra },
	};
}
