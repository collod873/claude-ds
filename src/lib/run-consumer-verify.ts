/**
 * `runConsumerVerify` — the A2 verify-gate runner (PRD #407 / issue #410).
 *
 * Detects the consumer's verify command (prefer an explicit `verify` /
 * `typecheck` script, else `tsc --noEmit`, else `build`), runs it, and
 * returns `{ ok, errors, scaffoldErrors, consumerErrors }` parsed from the
 * tsc-style output. Pure orchestration behind a simple interface so
 * mutating commands can gate their clean / converged / "no action required"
 * verdict on a real green tree and tests can stub the subprocess.
 *
 * **The contract:** any command that mutated the tree (`audit --fix`,
 * `heal`, `upgrade` post-apply, `sync` when it wrote) must call this before
 * emitting a success verdict. `ok === false` ⇒ the command surfaces the
 * offending errors and exits non-zero — never prints "clean."
 *
 * **Scaffold-vs-consumer split.** Pre-existing consumer errors that
 * claude-ds did not touch must not block the success verdict (the risk
 * noted in PRD #407): we partition errors by whether they live in a file
 * claude-ds owns or just touched. Scaffold errors block (`ok = false`);
 * consumer errors are reported as warnings via `consumerErrors` so the
 * caller can surface them without failing.
 *
 *  - **scaffold** = path matches `managedFiles` (exact pack-managed paths),
 *    OR sits under any `managedRoots` prefix (default: `design-system/`),
 *    OR is in the optional `touchedFiles` set (paths claude-ds wrote
 *    this run).
 *  - **consumer** = everything else.
 *
 * Errors with no file location (TS plumbing errors, "Cannot find module
 * 'tsconfig.json'") count as scaffold by default so an environment
 * failure of the verify command itself is never silently warned-on.
 */
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { detectPackageManager } from "./package-manager.js";

/** Parsed entry from `tsc --noEmit` (or compatible) output. */
export interface VerifyError {
	/** Path relative to the verify command's cwd (matches `cwd` arg). */
	file: string;
	line: number;
	col: number;
	/** TS error code like `TS2304`. Empty string for non-tsc shapes. */
	code: string;
	message: string;
	/** Raw line for debugging / display. */
	raw: string;
}

/** Result of the consumer verify run. */
export interface VerifyResult {
	/**
	 * `true` ⇒ no scaffold-caused errors. Pre-existing consumer errors do
	 * not flip this to false (warn-only — see module header). The verify
	 * subprocess exiting non-zero with no parseable errors counts as a
	 * scaffold error (env failure of the gate itself).
	 */
	ok: boolean;
	/** The resolved verify command label (e.g. `"npm run verify"`, `"npx tsc --noEmit"`). */
	command: string;
	/** Subprocess exit code. */
	exitCode: number;
	/** Every error parsed from the run. */
	errors: VerifyError[];
	/** Errors whose file is in `managedFiles`, under a `managedRoots` prefix, or in `touchedFiles`. */
	scaffoldErrors: VerifyError[];
	/** Errors whose file is none of the above (pre-existing consumer errors). */
	consumerErrors: VerifyError[];
	/** `true` ⇒ verify command timed out. */
	timedOut: boolean;
	/** Pre-existing or environmental note (e.g. "no verify command detected"). */
	reason?: string;
}

/** Injectable subprocess executor — tests stub this to assert no real spawn. */
export type ExecFn = (
	cmd: string,
	args: string[],
	opts: { cwd: string; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;

export interface RunConsumerVerifyOpts {
	/**
	 * Paths (relative to cwd) claude-ds wrote during this run. Errors in any
	 * of these count as scaffold errors and block the green verdict.
	 */
	touchedFiles?: Set<string>;
	/**
	 * Pack-managed paths (relative to cwd) — typically `ctx.manifest.files`.
	 * Errors in any of these count as scaffold errors.
	 */
	managedFiles?: Set<string>;
	/**
	 * Directory prefixes (with trailing slash). Errors under any of these
	 * count as scaffold errors. Defaults to `["design-system/"]` — the
	 * canonical scaffold root.
	 */
	managedRoots?: string[];
	/**
	 * Override the resolved verify command. Object form so tests can pin
	 * exactly what the subprocess runs.
	 */
	command?: { cmd: string; args: string[]; label: string };
	/** Override the subprocess executor (test seam). */
	exec?: ExecFn;
	/** Subprocess timeout. Default 60_000 ms. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MANAGED_ROOTS = ["design-system/"];

/**
 * Detect the consumer's verify command. Tries (in order):
 *   1. `verify` script in package.json
 *   2. `typecheck` script in package.json
 *   3. `tsc --noEmit` when `typescript` is a dep and `tsconfig.json` exists
 *   4. `build` script in package.json
 *
 * Returns `null` when nothing detectable is present — the caller decides
 * whether that is a hard failure or a soft skip.
 */
export async function detectVerifyCommand(
	cwd: string,
): Promise<{ cmd: string; args: string[]; label: string } | null> {
	let pkg: {
		scripts?: Record<string, string>;
		devDependencies?: Record<string, string>;
		dependencies?: Record<string, string>;
	} = {};
	try {
		pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
	} catch {
		// No package.json — fall through to the tsc / nothing branches.
	}

	const pm = await detectPackageManager(cwd);
	const runScript = (script: string): { cmd: string; args: string[]; label: string } => {
		if (pm === "yarn") return { cmd: "yarn", args: [script], label: `yarn ${script}` };
		return { cmd: pm, args: ["run", script], label: `${pm} run ${script}` };
	};

	if (pkg.scripts?.verify) return runScript("verify");
	if (pkg.scripts?.typecheck) return runScript("typecheck");

	const hasTsconfig = await exists(join(cwd, "tsconfig.json"));
	const hasTypescript = !!(pkg.devDependencies?.typescript || pkg.dependencies?.typescript);
	if (hasTsconfig && hasTypescript) {
		return { cmd: "npx", args: ["tsc", "--noEmit"], label: "npx tsc --noEmit" };
	}

	if (pkg.scripts?.build) return runScript("build");

	return null;
}

/**
 * Run the consumer verify command and return a structured result.
 *
 * Never throws — environmental failures are folded into the result
 * (`reason` + `exitCode`). The caller decides whether to print, exit
 * non-zero, or roll back.
 */
export async function runConsumerVerify(
	cwd: string,
	opts: RunConsumerVerifyOpts = {},
): Promise<VerifyResult> {
	const command = opts.command ?? (await detectVerifyCommand(cwd));
	if (!command) {
		return {
			ok: true,
			command: "(none)",
			exitCode: 0,
			errors: [],
			scaffoldErrors: [],
			consumerErrors: [],
			timedOut: false,
			reason: "no verify command detected (no `verify`/`typecheck`/`build` script and no tsc)",
		};
	}

	const exec = opts.exec ?? defaultExec;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const result = await exec(command.cmd, command.args, { cwd, timeoutMs });

	const errors = parseVerifyErrors(result.stdout + "\n" + result.stderr);
	const { scaffoldErrors, consumerErrors } = partitionErrors(errors, {
		touchedFiles: opts.touchedFiles,
		managedFiles: opts.managedFiles,
		managedRoots: opts.managedRoots ?? DEFAULT_MANAGED_ROOTS,
	});

	// Env failure: non-zero exit with no parseable errors. Treat as a
	// scaffold problem so the gate fails loud rather than warning the
	// operator about a silent runner crash.
	let ok = scaffoldErrors.length === 0;
	let reason: string | undefined;
	if (result.exitCode !== 0 && errors.length === 0) {
		ok = false;
		reason = `${command.label} exited ${result.exitCode} with no parseable errors`;
	}

	return {
		ok,
		command: command.label,
		exitCode: result.exitCode,
		errors,
		scaffoldErrors,
		consumerErrors,
		timedOut: result.timedOut,
		reason,
	};
}

/**
 * Parse `tsc --noEmit`-style diagnostics from a combined stdout/stderr
 * blob. Matches the canonical line shape
 *   `path/to/file.ts(12,7): error TS2304: Cannot find name 'Foo'.`
 * which `tsc`, `vue-tsc`, and most TS-driven verify scripts emit.
 *
 * Exported so the harness, integration tests, and ad-hoc tooling can
 * reuse the same parser the gate decides on.
 */
export function parseVerifyErrors(raw: string): VerifyError[] {
	const errors: VerifyError[] = [];
	const re = /^([^()\n]+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw)) !== null) {
		errors.push({
			file: m[1],
			line: Number(m[2]),
			col: Number(m[3]),
			code: m[4],
			message: m[5].trim(),
			raw: m[0],
		});
	}
	return errors;
}

interface PartitionOpts {
	touchedFiles?: Set<string>;
	managedFiles?: Set<string>;
	managedRoots: string[];
}

function partitionErrors(
	errors: VerifyError[],
	opts: PartitionOpts,
): { scaffoldErrors: VerifyError[]; consumerErrors: VerifyError[] } {
	const scaffoldErrors: VerifyError[] = [];
	const consumerErrors: VerifyError[] = [];
	for (const e of errors) {
		if (isScaffoldPath(e.file, opts)) {
			scaffoldErrors.push(e);
		} else {
			consumerErrors.push(e);
		}
	}
	return { scaffoldErrors, consumerErrors };
}

function isScaffoldPath(file: string, opts: PartitionOpts): boolean {
	const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
	if (opts.touchedFiles?.has(normalized)) return true;
	if (opts.managedFiles?.has(normalized)) return true;
	for (const root of opts.managedRoots) {
		const prefix = root.endsWith("/") ? root : root + "/";
		if (normalized.startsWith(prefix)) return true;
	}
	return false;
}

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/** Default subprocess executor — spawns the command and captures streams. */
const defaultExec: ExecFn = (cmd, args, { cwd, timeoutMs }) =>
	new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			// Force non-TTY / no-color so tsc's output is byte-stable for the parser.
			env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" },
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		const settle = (exitCode: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode, stdout, stderr, timedOut });
		};

		child.on("error", () => settle(127));
		child.on("close", (code, signal) => {
			const exit = code ?? (signal ? 124 : 1);
			settle(exit);
		});
	});
