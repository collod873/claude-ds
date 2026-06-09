/**
 * The TTY printer (PRD #325 sub-issue #330). This is the **only** module
 * in `src/lib/render/` allowed to statically import the new runtime deps
 * (`@clack/prompts`, `picocolors`, `ora`) — `tests/unit/render/tty-gated-deps`
 * enforces that structurally. Callers reach it via `loadColorAdapter()`,
 * `createProgress()`, and future prompt wrappers; each helper bails to a
 * no-op on the non-TTY path so a misuse never regresses the agent surface.
 *
 * Pure renderers (`renderDashboard`, `renderFindings`, `renderDecision`,
 * `renderCommitmentGateDiff`) never reach into this file — they accept a
 * `ColorAdapter` and the printer wires one in. That is the single seam.
 */

import ora, { type Ora } from "ora";
import pc from "picocolors";
import { type ColorAdapter, identityColor } from "./color.js";
import { isTTY } from "./tty.js";

const ttyColor: ColorAdapter = {
	green: pc.green,
	red: pc.red,
	dim: pc.dim,
	bold: pc.bold,
	cyan: pc.cyan,
};

/**
 * Return the `picocolors`-backed adapter when attached to a TTY, otherwise
 * the identity adapter. Synchronous because `picocolors` is a tiny static
 * lookup table — the import cost is borne by the static `import pc` above,
 * which only this file pays for. Non-TTY commands import the rest of the
 * render module without dragging this file in (see the structural test).
 */
export function loadColorAdapter(): ColorAdapter {
	return isTTY() ? ttyColor : identityColor;
}

/**
 * Print a flat line array to stdout. The thin TTY layer the issue calls for —
 * pure renderers produce the bytes; this writes them. One newline per line,
 * trailing newline at the end so output composes with breadcrumb prints.
 */
export function printLines(lines: string[]): void {
	if (lines.length === 0) return;
	process.stdout.write(lines.join("\n") + "\n");
}

/**
 * Live progress controller for long-running TTY commands (PRD #325 / sub-issue
 * #332). Returns a no-op controller on non-TTY so callers can call the same
 * API unconditionally — the agent (non-TTY) path's bytes never change.
 *
 * Writes to stderr so stdout stays the machine-readable channel. Registers a
 * SIGINT handler that clears the spinner before the process tears down: ora's
 * cursor-restore plus an explicit `spinner.stop()` is the "clean Ctrl-C"
 * acceptance the issue pins. `stop()` deregisters the handler so an idle CLI
 * process doesn't keep a SIGINT listener alive.
 */
export interface ProgressController {
	/** Begin (or replace) the active phase. Subsequent succeed/fail commits it. */
	start(text: string): void;
	/** Persist the active phase as completed (✔). */
	succeed(text?: string): void;
	/** Persist the active phase as failed (✖). The heal ceiling failure uses this. */
	fail(text?: string): void;
	/**
	 * Print a status line above the spinner — used for the heal iteration
	 * counter so the user can see the convergence loop progressing without
	 * losing the current phase's spinner.
	 */
	info(text: string): void;
	/** Tear down: clear any active spinner, restore the cursor, drop SIGINT. */
	stop(): void;
	/** True when a phase is currently spinning (start without succeed/fail/stop). */
	readonly active: boolean;
	/** False on non-TTY — the no-op controller. Lets callers branch only when needed. */
	readonly enabled: boolean;
}

const NOOP_PROGRESS: ProgressController = {
	start() {},
	succeed() {},
	fail() {},
	info() {},
	stop() {},
	active: false,
	enabled: false,
};

export function createProgress(): ProgressController {
	if (!isTTY()) return NOOP_PROGRESS;

	let spinner: Ora | null = null;
	let active = false;
	let sigintInstalled = false;

	const onSigint = (): void => {
		if (spinner) {
			spinner.stop();
			spinner = null;
		}
		active = false;
	};

	const installSigint = (): void => {
		if (sigintInstalled) return;
		process.once("SIGINT", onSigint);
		sigintInstalled = true;
	};

	const removeSigint = (): void => {
		if (!sigintInstalled) return;
		process.removeListener("SIGINT", onSigint);
		sigintInstalled = false;
	};

	installSigint();

	const makeSpinner = (text: string): Ora =>
		ora({
			text,
			stream: process.stderr,
			// discardStdin puts stdin in raw mode, which interferes with the test
			// harness (and any other stdin consumer). Spinner UX doesn't need it.
			discardStdin: false,
		});

	return {
		start(text) {
			if (spinner) spinner.stop();
			spinner = makeSpinner(text);
			spinner.start();
			active = true;
		},
		succeed(text) {
			if (spinner) {
				spinner.succeed(text);
				spinner = null;
			} else if (text !== undefined) {
				process.stderr.write(`✔ ${text}\n`);
			}
			active = false;
		},
		fail(text) {
			if (spinner) {
				spinner.fail(text);
				spinner = null;
			} else if (text !== undefined) {
				process.stderr.write(`✖ ${text}\n`);
			}
			active = false;
		},
		info(text) {
			if (spinner) {
				const current = spinner.text;
				spinner.stop();
				process.stderr.write(`${text}\n`);
				spinner = makeSpinner(current);
				spinner.start();
			} else {
				process.stderr.write(`${text}\n`);
			}
		},
		stop() {
			if (spinner) {
				spinner.stop();
				spinner = null;
			}
			active = false;
			removeSigint();
		},
		get active() {
			return active;
		},
		enabled: true,
	};
}
