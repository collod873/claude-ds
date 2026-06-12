import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { healCmd } from "../../src/commands/heal.js";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

// Issue #585 — heal's upfront consent gate. heal is the headless driver, but a
// human typing `claude-ds heal` in a terminal must see the same informed
// `[Enter]` gate the front door shows before any mutation: the projected plan,
// the per-rule `audit --fix` preview, then one prompt. Cancel exits without
// touching the tree; `--yes` (and the implied non-TTY path) skips the gate.
//
// The fixture is the #265 corrupt-baseline atom: `combo.tsx` references three DS
// atoms with no import block, so the planner schedules classify + audit --fix —
// a non-empty plan, which is the only state the gate has anything to consent to.
// Convergence relocates it to composites/; its presence there (or absence) is
// the proof that heal did or did not mutate.

const BASE_CFG = {
	packVersion: "v0.9.0",
	pack: "next-react",
	mode: "warn",
	domain_roots: ["features", "lib"],
	ds_aliases: ["@ds"],
};

async function fileExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/** Lay down the corrupt-baseline fixture whose plan is non-empty (classify + audit --fix). */
async function writeCorruptBaseline(dir: string): Promise<void> {
	await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
	await writeFile(
		join(dir, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { paths: { "@ds/*": ["./design-system/*"] } } }),
	);
	await mkdir(join(dir, "design-system/atoms"), { recursive: true });
	await mkdir(join(dir, "design-system/composites"), { recursive: true });
	for (const name of ["button", "input", "badge"]) {
		const Name = name[0].toUpperCase() + name.slice(1);
		await writeFile(
			join(dir, `design-system/atoms/${name}.tsx`),
			`export function ${Name}() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
		);
	}
	await writeFile(
		join(dir, "design-system/atoms/combo.tsx"),
		[
			`export function Combo() { return <div><Button/><Input/><Badge/></div>; }`,
			`export const meta = { kind: "atom" as const, examples: [] };`,
			"",
		].join("\n"),
	);
}

/**
 * Drive `healCmd` through its real consent-gate readline against a fake stdin,
 * capturing stdout/stderr and stubbing `process.exit`. Mirrors the front door's
 * `captureFrontDoorInteractive` harness so the gate's prompt string and the
 * empty-approves / other-cancels contract are exercised, not stubbed.
 */
async function runHeal(
	cwd: string,
	stdin: string,
	opts: { interactive?: boolean; yes?: boolean },
): Promise<{ stdout: string; exitCode: number | null }> {
	const origStdoutWrite = process.stdout.write.bind(process.stdout);
	const origConsoleLog = console.log;
	const origConsoleInfo = console.info;
	const origConsoleError = console.error;
	const origStdinDesc = Object.getOwnPropertyDescriptor(process, "stdin");
	const origExit = process.exit;
	let stdout = "";
	let exitCode: number | null = null;
	const fmt = (args: unknown[]) =>
		`${args
			.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
			.join(" ")}\n`;
	process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
		stdout += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
		const cb = rest.find((r) => typeof r === "function") as ((err?: Error) => void) | undefined;
		if (cb) cb();
		return true;
	}) as typeof process.stdout.write;
	console.log = (...args: unknown[]) => {
		stdout += fmt(args);
	};
	console.info = (...args: unknown[]) => {
		stdout += fmt(args);
	};
	console.error = (...args: unknown[]) => {
		stdout += fmt(args);
	};
	const fakeStdin = Readable.from(stdin) as Readable & { isTTY?: boolean };
	fakeStdin.isTTY = false;
	Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
	(process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
		exitCode = code ?? 0;
		throw new Error(`__exit__${code ?? 0}`);
	}) as never;
	try {
		await healCmd({ cwd, maxIterations: 5, ...opts });
	} catch (e) {
		if (!(e instanceof Error) || !e.message.startsWith("__exit__")) throw e;
	} finally {
		process.stdout.write = origStdoutWrite as typeof process.stdout.write;
		console.log = origConsoleLog;
		console.info = origConsoleInfo;
		console.error = origConsoleError;
		(process as unknown as { exit: typeof origExit }).exit = origExit;
		if (origStdinDesc) Object.defineProperty(process, "stdin", origStdinDesc);
	}
	return { stdout, exitCode };
}

describe("claude-ds heal — upfront consent gate (#585)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("shows the plan preview + prompt in a TTY; cancel exits without mutation", async () => {
		await writeCorruptBaseline(dir);
		const combo = join(dir, "design-system/atoms/combo.tsx");
		expect(await fileExists(combo)).toBe(true);

		// Anything other than [Enter] cancels.
		const { stdout } = await runHeal(dir, "no\n", { interactive: true });

		// The gate rendered the commitment preview and the [Enter] prompt …
		expect(stdout).toContain("I'll bring this tree to clean");
		expect(stdout).toContain("[Enter] to run all, anything else to cancel");
		expect(stdout).toContain("heal: cancelled — nothing changed.");
		// … and the cancel returned before the loop, so nothing moved.
		expect(await fileExists(combo)).toBe(true);
		expect(await fileExists(join(dir, "design-system/composites/combo.tsx"))).toBe(false);
	}, 30000);

	it("[Enter] approves the plan and drives the loop to convergence", async () => {
		await writeCorruptBaseline(dir);

		// Empty input ([Enter]) approves the whole plan.
		const { stdout } = await runHeal(dir, "\n", { interactive: true });

		expect(stdout).toContain("I'll bring this tree to clean");
		// Approval let the loop run: the corrupt atom relocated to composites/.
		expect(await fileExists(join(dir, "design-system/composites/combo.tsx"))).toBe(true);
		expect(await fileExists(join(dir, "design-system/atoms/combo.tsx"))).toBe(false);
		expect(stdout).toMatch(/converged/);
	}, 30000);

	it("--yes skips the gate and drives straight through without prompting", async () => {
		await writeCorruptBaseline(dir);

		const { stdout } = await runHeal(dir, "", { interactive: true, yes: true });

		// No gate preview, no prompt — and the loop still converged.
		expect(stdout).not.toContain("I'll bring this tree to clean");
		expect(stdout).not.toContain("[Enter] to run all");
		expect(await fileExists(join(dir, "design-system/composites/combo.tsx"))).toBe(true);
		expect(stdout).toMatch(/converged/);
	}, 30000);

	it("non-TTY implies --yes: no gate, the loop drives", async () => {
		await writeCorruptBaseline(dir);

		const { stdout } = await runHeal(dir, "", { interactive: false });

		expect(stdout).not.toContain("I'll bring this tree to clean");
		expect(stdout).not.toContain("[Enter] to run all");
		expect(await fileExists(join(dir, "design-system/composites/combo.tsx"))).toBe(true);
		expect(stdout).toMatch(/converged/);
	}, 30000);
});
