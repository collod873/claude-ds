import { Readable } from "node:stream";
import { buildProgram } from "../../src/cli.js";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface RunOpts {
	cwd: string;
	stdin?: string;
	env?: NodeJS.ProcessEnv;
}

class ExitError extends Error {
	constructor(public code: number) {
		super(`process.exit(${code})`);
	}
}

// Runs the CLI in-process. Each Cmd function accepts opts.cwd, so we thread
// the test's tmpdir through buildProgram() — no chdir, no spawn. Captures
// stdout/stderr by intercepting the underlying writes; stubs process.exit so
// non-zero exits become a returned code rather than killing the test runner.
export async function runCli(args: string[], opts: RunOpts): Promise<RunResult> {
	const origExit = process.exit;
	const origStdoutWrite = process.stdout.write.bind(process.stdout);
	const origStderrWrite = process.stderr.write.bind(process.stderr);
	const origConsoleLog = console.log;
	const origConsoleError = console.error;
	const origConsoleWarn = console.warn;
	const origConsoleInfo = console.info;
	const origStdinDesc = Object.getOwnPropertyDescriptor(process, "stdin");
	const origEnv = opts.env ? { ...process.env } : null;

	let stdout = "";
	let stderr = "";

	const captureStdout: typeof process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
		stdout += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
		const cb = rest.find((r) => typeof r === "function") as ((err?: Error) => void) | undefined;
		if (cb) cb();
		return true;
	}) as typeof process.stdout.write;
	const captureStderr: typeof process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
		stderr += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
		const cb = rest.find((r) => typeof r === "function") as ((err?: Error) => void) | undefined;
		if (cb) cb();
		return true;
	}) as typeof process.stderr.write;

	process.stdout.write = captureStdout;
	process.stderr.write = captureStderr;

	// vitest intercepts console.* for its reporter, so process.stdout.write
	// capture alone misses console.log output. Replace console methods directly
	// to catch both the CLI's info()/err() (which call console.log/error) and
	// anything else that bypasses process.std{out,err}.write.
	const fmt = (args: unknown[]) =>
		args
			.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
			.join(" ") + "\n";
	console.log = (...args: unknown[]) => {
		stdout += fmt(args);
	};
	console.info = (...args: unknown[]) => {
		stdout += fmt(args);
	};
	console.error = (...args: unknown[]) => {
		stderr += fmt(args);
	};
	console.warn = (...args: unknown[]) => {
		stderr += fmt(args);
	};

	(process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
		throw new ExitError(code ?? 0);
	}) as never;

	// Non-TTY stdin backed by opts.stdin. Commands branch on isTTY for prompts.
	const fakeStdin = Readable.from(opts.stdin ?? "") as Readable & { isTTY?: boolean };
	fakeStdin.isTTY = false;
	Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });

	if (opts.env) {
		for (const k of Object.keys(process.env)) delete process.env[k];
		Object.assign(process.env, opts.env);
	}

	let code = 0;
	try {
		const program = buildProgram({ cwd: opts.cwd });
		program.exitOverride();
		await program.parseAsync(["node", "claude-ds", ...args]);
	} catch (e) {
		if (e instanceof ExitError) {
			code = e.code;
		} else if (e && typeof e === "object" && "code" in e && "exitCode" in e) {
			// commander CommanderError (raised via exitOverride): includes --help (0)
			// and validation failures (non-zero).
			const ce = e as { exitCode: number; message: string };
			code = ce.exitCode;
			if (ce.message && code !== 0) stderr += `error: ${ce.message}\n`;
		} else {
			const msg = e instanceof Error ? e.message : String(e);
			stderr += `error: ${msg}\n`;
			code = 1;
		}
	} finally {
		process.stdout.write = origStdoutWrite as typeof process.stdout.write;
		process.stderr.write = origStderrWrite as typeof process.stderr.write;
		console.log = origConsoleLog;
		console.info = origConsoleInfo;
		console.error = origConsoleError;
		console.warn = origConsoleWarn;
		(process as unknown as { exit: typeof origExit }).exit = origExit;
		if (origStdinDesc) Object.defineProperty(process, "stdin", origStdinDesc);
		if (origEnv) {
			for (const k of Object.keys(process.env)) delete process.env[k];
			Object.assign(process.env, origEnv);
		}
	}

	return { code, stdout, stderr };
}
