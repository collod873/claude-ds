/**
 * The front door runs the same consumer-verify gate at convergence as heal
 * (issue #510). Before this, `front-door.ts` printed "✓ Tree is clean." straight
 * after `driveRemediation` converged — no gate — so a red consumer typecheck
 * (e.g. stale scaffold output) could coexist with the clean verdict. heal gates
 * its converged verdict on `runConsumerVerify` (#410 / PRD #407); the front door
 * now does too, with the same attribution (managedFiles + managedRoots).
 *
 * These tests stub `runConsumerVerify` at the in-process boundary (mirroring
 * `verify-gate.test.ts`) and drive the real convergence loop against a pinned
 * adopted fixture, then assert the front door's verdict tracks the gate result.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../helpers/runcli.js";
import { cleanup, freshTmpDir } from "../helpers/tmpdir.js";

vi.mock("../../src/lib/run-consumer-verify.js", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/run-consumer-verify.js")>(
		"../../src/lib/run-consumer-verify.js",
	);
	return { ...actual, runConsumerVerify: vi.fn() };
});

import { frontDoorCmd } from "../../src/commands/front-door.js";
import { runConsumerVerify, type VerifyResult } from "../../src/lib/run-consumer-verify.js";

/** A green gate — no scaffold errors. */
function greenVerify(overrides: Partial<VerifyResult> = {}): VerifyResult {
	return {
		ok: true,
		command: "npx tsc --noEmit",
		exitCode: 0,
		errors: [],
		scaffoldErrors: [],
		handVerifyErrors: [],
		consumerErrors: [],
		timedOut: false,
		...overrides,
	};
}

/**
 * Drive the front door headless (no [Enter]), capturing stdout. process.exit is
 * stubbed by the suite's exitSpy, so a red gate's `process.exit(1)` is a no-op
 * and the function returns rather than killing the runner.
 */
async function captureFrontDoor(cwd: string): Promise<string> {
	const origStdoutWrite = process.stdout.write.bind(process.stdout);
	const origConsoleLog = console.log;
	const origConsoleInfo = console.info;
	let stdout = "";
	const fmt = (args: unknown[]) =>
		args
			.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
			.join(" ") + "\n";
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
	try {
		await frontDoorCmd({ cwd, interactive: false, yes: true, maxIterations: 5 });
	} finally {
		process.stdout.write = origStdoutWrite as typeof process.stdout.write;
		console.log = origConsoleLog;
		console.info = origConsoleInfo;
	}
	return stdout;
}

/** Adopt + pin v1.0.0 so the converge loop has work (pin bump) and reaches a fixed point. */
async function adoptedStalePin(dir: string): Promise<void> {
	const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
	expect(r.code).toBe(0);
	const cfgPath = join(dir, ".claude-ds.json");
	const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
	cfg.packVersion = "v1.0.0";
	await writeFile(cfgPath, JSON.stringify(cfg));
}

describe("front door verify gate at convergence (#510)", () => {
	let dir: string;
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		dir = await freshTmpDir();
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
		vi.mocked(runConsumerVerify).mockReset();
		vi.mocked(runConsumerVerify).mockResolvedValue(greenVerify());
	});

	afterEach(async () => {
		exitSpy.mockRestore();
		await cleanup(dir);
	});

	it("red gate: scaffold errors flip the verdict — no 'Tree is clean', exits non-zero", async () => {
		await adoptedStalePin(dir);

		// The injected break: the consumer's verify reports a scaffold-attributed
		// error against a managed root — exactly the #509 stale-showcase shape.
		vi.mocked(runConsumerVerify).mockResolvedValue(
			greenVerify({
				ok: false,
				exitCode: 1,
				errors: [
					{
						file: "design-system/atoms/button.showcase.tsx",
						line: 7,
						col: 3,
						code: "TS2322",
						message: "Type 'string' is not assignable to type 'number'.",
						raw: "",
					},
				],
				scaffoldErrors: [
					{
						file: "design-system/atoms/button.showcase.tsx",
						line: 7,
						col: 3,
						code: "TS2322",
						message: "Type 'string' is not assignable to type 'number'.",
						raw: "",
					},
				],
			}),
		);

		const out = await captureFrontDoor(dir);

		expect(vi.mocked(runConsumerVerify)).toHaveBeenCalledOnce();
		// The crucial bit: the clean verdict was NOT emitted on a red typecheck.
		expect(out).not.toMatch(/Tree is clean/);
		// The red-gate report names the offending file + code.
		expect(out).toMatch(/verify gate failed/i);
		expect(out).toContain("button.showcase.tsx");
		expect(out).toContain("TS2322");
		// Exit non-zero, like heal.
		expect(exitSpy).toHaveBeenCalledWith(1);
	}, 60000);

	it("green gate: clean verdict still prints when verify passes", async () => {
		await adoptedStalePin(dir);
		vi.mocked(runConsumerVerify).mockResolvedValue(greenVerify());

		const out = await captureFrontDoor(dir);

		expect(vi.mocked(runConsumerVerify)).toHaveBeenCalledOnce();
		expect(out).toMatch(/Tree is clean/);
		expect(exitSpy).not.toHaveBeenCalledWith(1);
	}, 60000);

	it("pre-existing consumer errors are non-blocking: clean verdict still prints", async () => {
		await adoptedStalePin(dir);
		vi.mocked(runConsumerVerify).mockResolvedValue(
			greenVerify({
				exitCode: 1,
				errors: [
					{
						file: "src/legacy/page.tsx",
						line: 99,
						col: 2,
						code: "TS2304",
						message: "Cannot find name 'Bar'.",
						raw: "",
					},
				],
				consumerErrors: [
					{
						file: "src/legacy/page.tsx",
						line: 99,
						col: 2,
						code: "TS2304",
						message: "Cannot find name 'Bar'.",
						raw: "",
					},
				],
			}),
		);

		const out = await captureFrontDoor(dir);

		expect(out).toMatch(/Tree is clean/);
		expect(exitSpy).not.toHaveBeenCalledWith(1);
	}, 60000);
});
