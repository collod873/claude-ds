/**
 * The verify-state ledger (PRD #635 Module 1 / issue #641). A red verify gate
 * persists across invocations so a later bare run can re-check before printing
 * any clean verdict.
 *
 * This suite pins the pure module: building a record from a VerifyResult,
 * round-tripping it through `readVerifyLedger`, and — the capstone — asserting
 * the write flows through the Runner (`run()`), landing real bytes on disk.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VerifyResult } from "../../src/lib/run-consumer-verify.js";
import { run } from "../../src/lib/runner.js";
import {
	readVerifyLedger,
	VERIFY_LEDGER_PATH,
	verifyLedgerRecord,
	writeVerifyLedger,
} from "../../src/lib/verify-ledger.js";
import { makeFakeCtx } from "../helpers/fake-ctx.js";
import { cleanup, freshTmpDir } from "../helpers/tmpdir.js";

function verifyError(file: string) {
	return { file, line: 2, col: 1, code: "TS2322", message: "boom", raw: "" };
}

function greenResult(): VerifyResult {
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

function redResult(): VerifyResult {
	const a = verifyError("design-system/atoms/combobox.showcase.tsx");
	const b = verifyError("design-system/atoms/button.tsx");
	return {
		ok: false,
		command: "npx tsc --noEmit",
		exitCode: 1,
		errors: [a, b],
		scaffoldErrors: [a, b],
		handVerifyErrors: [],
		consumerErrors: [],
		timedOut: false,
	};
}

describe("verify-state ledger record", () => {
	it("records a red verdict with a deduplicated, sorted failing-file summary and run id", () => {
		const record = verifyLedgerRecord(redResult(), "run-123");
		expect(record).toEqual({
			verdict: "red",
			runId: "run-123",
			failingFiles: ["design-system/atoms/button.tsx", "design-system/atoms/combobox.showcase.tsx"],
			command: "npx tsc --noEmit",
		});
	});

	it("records a green verdict with no failing files", () => {
		const record = verifyLedgerRecord(greenResult(), "run-456");
		expect(record.verdict).toBe("green");
		expect(record.failingFiles).toEqual([]);
	});
});

describe("verify-state ledger persistence through the Runner", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("writes the record to disk through run() and round-trips via readVerifyLedger", async () => {
		const ctx = makeFakeCtx(dir);
		const record = verifyLedgerRecord(redResult(), "run-789");

		const report = await run(ctx, [writeVerifyLedger(record)], "apply");
		expect(report.applied).toHaveLength(1);

		// Filesystem assertion: the persisted record exists on disk.
		const raw = await readFile(join(dir, VERIFY_LEDGER_PATH), "utf8");
		expect(JSON.parse(raw)).toEqual(record);

		const read = await readVerifyLedger(dir);
		expect(read).toEqual(record);
	});

	it("re-writing the same record is a no-op (Runner sees no Change)", async () => {
		const ctx = makeFakeCtx(dir);
		const record = verifyLedgerRecord(greenResult(), "run-1");
		await run(ctx, [writeVerifyLedger(record)], "apply");

		const second = await run(ctx, [writeVerifyLedger(record)], "apply");
		expect(second.applied).toHaveLength(0);
	});

	it("a new run id with the same outcome is a no-op — bookkeeping never churns the tree", async () => {
		const ctx = makeFakeCtx(dir);
		await run(ctx, [writeVerifyLedger(verifyLedgerRecord(redResult(), "run-1"))], "apply");

		// Same red gate, fresh run id (the every-invocation case) — no write, and
		// the persisted run id stays put so the tree is a fixed point.
		const second = await run(
			ctx,
			[writeVerifyLedger(verifyLedgerRecord(redResult(), "run-2"))],
			"apply",
		);
		expect(second.applied).toHaveLength(0);
		expect((await readVerifyLedger(dir))?.runId).toBe("run-1");
	});

	it("a changed verdict advances the record (green → red writes)", async () => {
		const ctx = makeFakeCtx(dir);
		await run(ctx, [writeVerifyLedger(verifyLedgerRecord(greenResult(), "run-1"))], "apply");

		const flipped = await run(
			ctx,
			[writeVerifyLedger(verifyLedgerRecord(redResult(), "run-2"))],
			"apply",
		);
		expect(flipped.applied).toHaveLength(1);
		expect((await readVerifyLedger(dir))?.verdict).toBe("red");
	});

	it("returns null when no record exists and tolerates a corrupt record", async () => {
		expect(await readVerifyLedger(dir)).toBeNull();
		await run(
			makeFakeCtx(dir),
			[writeVerifyLedger(verifyLedgerRecord(greenResult(), "x"))],
			"apply",
		);
		// Corrupt the file → degrade to the fast path, never throw.
		const ctx = makeFakeCtx(dir);
		await run(
			ctx,
			[
				{
					name: "corrupt",
					async plan() {
						return [
							{
								kind: "write" as const,
								path: VERIFY_LEDGER_PATH,
								before: null,
								after: Buffer.from("not json{"),
							},
						];
					},
				},
			],
			"apply",
		);
		expect(await readVerifyLedger(dir)).toBeNull();
	});
});
