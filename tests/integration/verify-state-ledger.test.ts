/**
 * Verify-state ledger, end to end (PRD #635 Module 1 / issue #641).
 *
 * The trust break: run 1 ends red, run 2 prints "Loop is clean" over the same
 * unfixed build. The fix persists the gate outcome and re-checks before any
 * clean verdict.
 *
 * This suite drives the real front door against a clean adopted tree (an empty
 * planner plan — the fast path) and pins the ledger's gate on the clean verdict:
 *   - last record red → bare invocation re-runs the consumer-verify gate;
 *   - last record green or absent → no re-run (fast path preserved);
 *   - a green re-check clears the record so the next run is fast again;
 *   - a red re-check renders the shared partitioned red-gate report and exits.
 *
 * `runConsumerVerify` is stubbed at the in-process boundary (mirroring
 * `heal-red-gate-report.test.ts`) so the re-check's invocation is asserted by
 * call count, and the failing tree is simulated without a real subprocess.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/run-consumer-verify.js", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/run-consumer-verify.js")>(
		"../../src/lib/run-consumer-verify.js",
	);
	return { ...actual, runConsumerVerify: vi.fn() };
});

import { frontDoorCmd } from "../../src/commands/front-door.js";
import { runConsumerVerify, type VerifyResult } from "../../src/lib/run-consumer-verify.js";
import { readVerifyLedger, VERIFY_LEDGER_PATH } from "../../src/lib/verify-ledger.js";
import { runCli } from "../helpers/runcli.js";
import { cleanup, freshTmpDir } from "../helpers/tmpdir.js";

function green(): VerifyResult {
	return {
		ok: true,
		command: "npx tsc --noEmit",
		exitCode: 0,
		errors: [],
		scaffoldErrors: [],
		handVerifyErrors: [],
		consumerErrors: [],
		timedOut: false,
	};
}

function redScaffold(): VerifyResult {
	const e = {
		file: "design-system/atoms/combobox.showcase.tsx",
		line: 2,
		col: 30,
		code: "TS2322",
		message: "Property 'size' does not exist.",
		raw: "",
	};
	return {
		ok: false,
		command: "npx tsc --noEmit",
		exitCode: 1,
		errors: [e],
		scaffoldErrors: [e],
		handVerifyErrors: [],
		consumerErrors: [],
		timedOut: false,
	};
}

/** Seed the persisted record as if a prior run ended on this verdict. */
async function seedLedger(dir: string, verdict: "green" | "red"): Promise<void> {
	await writeFile(
		join(dir, VERIFY_LEDGER_PATH),
		`${JSON.stringify(
			{
				verdict,
				runId: "seed",
				failingFiles: verdict === "red" ? ["design-system/atoms/combobox.showcase.tsx"] : [],
				command: "npx tsc --noEmit",
			},
			null,
			2,
		)}\n`,
	);
}

/** Drive the front door's empty-plan path, capturing stdout. */
async function captureFrontDoor(dir: string): Promise<string> {
	const origWrite = process.stdout.write.bind(process.stdout);
	const origLog = console.log;
	const origInfo = console.info;
	let stdout = "";
	const fmt = (args: unknown[]) =>
		`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
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
		await frontDoorCmd({ cwd: dir, interactive: false });
	} finally {
		process.stdout.write = origWrite as typeof process.stdout.write;
		console.log = origLog;
		console.info = origInfo;
	}
	return stdout;
}

describe("verify-state ledger gates the front door's clean verdict (#641)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await freshTmpDir();
		// Default the gate green so adopt/heal converge during setup.
		vi.mocked(runConsumerVerify).mockResolvedValue(green());

		const adopted = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopted.code).toBe(0);
		await runCli(["heal"], { cwd: dir });

		// Add a user `build` script the same way the front-door suite does, so the
		// managed `package.json` does not drift and the planner plan stays empty.
		const pkgPath = join(dir, "package.json");
		const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
		pkg.scripts = { build: "next build", ...pkg.scripts };
		await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

		// Clear the setup's gate calls so each test asserts only the re-check.
		vi.mocked(runConsumerVerify).mockClear();
	});

	afterEach(async () => {
		await cleanup(dir);
		vi.restoreAllMocks();
	});

	it("last record red → re-runs the verify gate before any clean verdict", async () => {
		await seedLedger(dir, "red");
		vi.mocked(runConsumerVerify).mockResolvedValue(green());

		const out = await captureFrontDoor(dir);

		// The stub was invoked — the re-check ran rather than asserting clean blind.
		expect(runConsumerVerify).toHaveBeenCalledTimes(1);
		// Green re-check → the clean verdict is now earned.
		expect(out).toMatch(/Nothing to remediate — the tree is clean/);
	});

	it("last record green → no re-run (fast path preserved, stub not invoked)", async () => {
		await seedLedger(dir, "green");

		const out = await captureFrontDoor(dir);

		expect(runConsumerVerify).not.toHaveBeenCalled();
		expect(out).toMatch(/Nothing to remediate — the tree is clean/);
	});

	it("no record → no re-run (fast path preserved, stub not invoked)", async () => {
		// Remove the green record heal wrote during setup so there is no record.
		await rm(join(dir, VERIFY_LEDGER_PATH), { force: true });

		const out = await captureFrontDoor(dir);

		expect(runConsumerVerify).not.toHaveBeenCalled();
		expect(out).toMatch(/Nothing to remediate — the tree is clean/);
	});

	it("green re-check clears the record → the next run takes the fast path", async () => {
		await seedLedger(dir, "red");
		vi.mocked(runConsumerVerify).mockResolvedValue(green());

		// First bare run: re-checks (red record) and clears the record to green.
		await captureFrontDoor(dir);
		expect(runConsumerVerify).toHaveBeenCalledTimes(1);
		expect((await readVerifyLedger(dir))?.verdict).toBe("green");

		vi.mocked(runConsumerVerify).mockClear();

		// Second bare run: the record is green, so no re-check.
		const out = await captureFrontDoor(dir);
		expect(runConsumerVerify).not.toHaveBeenCalled();
		expect(out).toMatch(/Nothing to remediate — the tree is clean/);
	});

	it("red re-check → renders the partitioned red-gate report and exits non-zero", async () => {
		await seedLedger(dir, "red");
		vi.mocked(runConsumerVerify).mockResolvedValue(redScaffold());

		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit");
		}) as never);

		await expect(captureFrontDoor(dir)).rejects.toThrow("exit");

		expect(runConsumerVerify).toHaveBeenCalledTimes(1);
		expect(exitSpy).toHaveBeenCalledWith(1);
		// The re-check outcome is persisted (still red — no green recorded since).
		expect((await readVerifyLedger(dir))?.verdict).toBe("red");
	});
});

describe("verify-state ledger persists a red gate to disk (#641)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
		vi.restoreAllMocks();
	});

	it("after a run whose verify gate is red, a red record exists on disk", async () => {
		vi.mocked(runConsumerVerify).mockResolvedValue(green());
		const adopted = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopted.code).toBe(0);

		// A red gate at heal's convergence persists verdict + failing files + run id.
		vi.mocked(runConsumerVerify).mockResolvedValue(redScaffold());
		await runCli(["heal"], { cwd: dir });

		const record = await readVerifyLedger(dir);
		expect(record?.verdict).toBe("red");
		expect(record?.failingFiles).toEqual(["design-system/atoms/combobox.showcase.tsx"]);
		expect(typeof record?.runId).toBe("string");
		expect(record?.runId.length).toBeGreaterThan(0);
	});
});
