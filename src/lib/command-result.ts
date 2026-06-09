/**
 * `CommandResult` — the value a loop-member command returns (PRD #468 / issue
 * #437, ADR-0018).
 *
 * Before this type the four loop members (`sync`, `upgrade`/`repair`,
 * `classify`, `audit`) drove their verdict through `process.exit` + global
 * stdout. The remediation driver had to monkeypatch `process.exit`
 * (`runWithoutExit`) to keep a non-zero sub-command from tearing down the loop,
 * and the commands carried `skipNextStep` / `skipVerifyGate` flags purely to
 * mute their CLI personality when driven.
 *
 * Functions-first replaces that side-channel: a loop member returns a
 * `CommandResult` and the **caller** decides what to do with it.
 *   - The CLI entry (`cli.ts`) maps `exitCode` to `process.exit` and renders the
 *     returned `nextStep` breadcrumb.
 *   - The remediation driver (`heal`, the front door) reads the result and
 *     **discards** the breadcrumb — the driver owns the single authoritative
 *     verdict at convergence (ADR-0018), so no `→ Next` prints on the loop path.
 */
import type { NextStepCommand, NextStepContext } from "./log.js";

/**
 * The non-byte verdict a command reached:
 *   - `success`        — the command did its job; exit 0.
 *   - `findings-remain` — work the command could not resolve is left (audit
 *     findings, a red verify gate); exit 1.
 *   - `error`          — a user-input or environment failure (no config, dirty
 *     tree, bad flag, apply failure); exit 2 / 130.
 */
export type CommandOutcome = "success" | "findings-remain" | "error";

/**
 * A deferred `→ Next` breadcrumb. The command computes which steering line it
 * *would* print and returns it here instead of writing to stdout; the CLI
 * renders it via `printNextStep`, the driver ignores it. `null`/absent means no
 * breadcrumb (e.g. the `--json` machine surface, or an error path).
 */
export interface NextStepHint {
	command: NextStepCommand;
	ctx: NextStepContext;
}

export interface CommandResult {
	outcome: CommandOutcome;
	/** The exit code the CLI maps to `process.exit`. */
	exitCode: number;
	/** Caller-owned next-step breadcrumb; rendered by the CLI, discarded by the driver. */
	nextStep?: NextStepHint;
}

/** A clean (exit 0) result, optionally carrying a next-step breadcrumb. */
export function success(nextStep?: NextStepHint): CommandResult {
	return nextStep
		? { outcome: "success", exitCode: 0, nextStep }
		: { outcome: "success", exitCode: 0 };
}

/** A findings-remain (exit 1) result — work the command could not finish. */
export function findingsRemain(nextStep?: NextStepHint): CommandResult {
	return nextStep
		? { outcome: "findings-remain", exitCode: 1, nextStep }
		: { outcome: "findings-remain", exitCode: 1 };
}

/** A user-input / environment error result (exit 2 by default, 130 for aborts). */
export function commandError(exitCode = 2): CommandResult {
	return { outcome: "error", exitCode };
}
