/**
 * Integration test for the A2 verify gate (PRD #407 / issue #410).
 *
 * Acceptance criterion from the issue:
 *   > e2e: an injected break makes `audit --fix` exit non-zero and report
 *   > the failure instead of "No action required".
 *
 * The "injected break" here is a stubbed `runConsumerVerify` that returns
 * scaffold errors. The real subprocess gate is exercised by the e2e
 * harness (`tests/e2e/smoke.test.ts`) once `dist/` is built; this test
 * locks the **contract** at the in-process boundary so any future audit
 * branch that forgets to gate fails this test immediately.
 *
 * What this asserts end-to-end inside `auditCmd({ fix: true })`:
 *
 *  1. When `runConsumerVerify` returns `ok: false` with scaffold errors,
 *     audit exits non-zero, prints the failure on stderr, and does NOT
 *     print the prior "No action required" verdict.
 *  2. When `runConsumerVerify` returns `ok: true`, audit prints the
 *     "verified via <cmd>" verdict — never "→ Next: run <build>" homework.
 *  3. Pre-existing consumer errors (`consumerErrors`) flow through as a
 *     warn-only note but do not block the success verdict.
 *  4. The verify gate is reached only when audit --fix actually mutated the
 *     tree — the read-only audit path skips it.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, freshTmpDir } from "../helpers/tmpdir.js";

vi.mock("../../src/lib/log.js", async () => {
	const actual =
		await vi.importActual<typeof import("../../src/lib/log.js")>("../../src/lib/log.js");
	return {
		...actual,
		info: vi.fn(),
		err: vi.fn(),
		printNextStep: vi.fn(),
	};
});

vi.mock("../../src/lib/run-consumer-verify.js", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/run-consumer-verify.js")>(
		"../../src/lib/run-consumer-verify.js",
	);
	return { ...actual, runConsumerVerify: vi.fn() };
});

import { auditCmd } from "../../src/commands/audit.js";
import { err, info, printNextStep } from "../../src/lib/log.js";
import { runConsumerVerify } from "../../src/lib/run-consumer-verify.js";

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Scaffold a Crewops-shaped fixture with a `meta.kind`-missing atom. Audit
 * `--fix` will run `mergeMetaKind` against this file — a real mutation, so
 * the verify gate is reached.
 */
async function scaffoldFixtureWithFixableDrift(cwd: string): Promise<void> {
	await writeFile(
		join(cwd, ".claude-ds.json"),
		JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn" }),
	);
	await mkdir(join(cwd, "design-system/atoms"), { recursive: true });
	// No `kind` on the meta — meta-kind-missing fixer rewrites it.
	await writeFile(
		join(cwd, "design-system/atoms/button.tsx"),
		[
			`export function Button() { return <button />; }`,
			`export const meta = { examples: [] };`,
			``,
		].join("\n"),
	);
}

describe("verify gate — audit --fix (PRD #407 / issue #410)", () => {
	let dir: string;
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		dir = await freshTmpDir();
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
		vi.mocked(info).mockClear();
		vi.mocked(err).mockClear();
		vi.mocked(printNextStep).mockClear();
		vi.mocked(runConsumerVerify).mockReset();
	});

	afterEach(async () => {
		exitSpy.mockRestore();
		await cleanup(dir);
	});

	it("exits non-zero and reports the failure when verify returns scaffold errors (the injected break)", async () => {
		await scaffoldFixtureWithFixableDrift(dir);

		// The injected break: verify gate reports a scaffold error against the
		// file claude-ds just mutated.
		vi.mocked(runConsumerVerify).mockResolvedValue({
			ok: false,
			command: "npx tsc --noEmit",
			exitCode: 1,
			errors: [
				{
					file: "design-system/atoms/button.tsx",
					line: 2,
					col: 1,
					code: "TS2300",
					message: "Duplicate identifier 'meta'.",
					raw: "",
				},
			],
			scaffoldErrors: [
				{
					file: "design-system/atoms/button.tsx",
					line: 2,
					col: 1,
					code: "TS2300",
					message: "Duplicate identifier 'meta'.",
					raw: "",
				},
			],
			consumerErrors: [],
			timedOut: false,
		});

		// The CLI opts into the gate via `verify: true` (issue #437): ownership of
		// the verify gate moved to the caller; the loop driver omits it.
		const result = await auditCmd({ fix: true, verify: true, cwd: dir });

		expect(vi.mocked(runConsumerVerify)).toHaveBeenCalledOnce();
		expect(result.exitCode).toBe(1);
		expect(result.outcome).toBe("findings-remain");

		const errMessages = vi.mocked(err).mock.calls.map((c) => String(c[0]));
		const failureLine = errMessages.find((m) => m.includes("verify gate failed"));
		expect(failureLine, errMessages.join("\n")).toBeDefined();
		expect(errMessages.some((m) => m.includes("TS2300"))).toBe(true);
		expect(errMessages.some((m) => m.includes("button.tsx"))).toBe(true);

		// The crucial bit: success verdict was NOT emitted.
		const infoMessages = vi.mocked(info).mock.calls.map((c) => String(c[0]));
		expect(infoMessages.find((m) => m.startsWith("No action required"))).toBeUndefined();

		// The retired homework: no "→ Next: run <build>" breadcrumb after audit --fix.
		const nextStepCalls = vi.mocked(printNextStep).mock.calls;
		expect(nextStepCalls.some(([cmd]) => cmd === "audit-fix")).toBe(false);
	});

	it("emits the green verdict (verified via …) when verify returns ok", async () => {
		await scaffoldFixtureWithFixableDrift(dir);

		vi.mocked(runConsumerVerify).mockResolvedValue({
			ok: true,
			command: "npx tsc --noEmit",
			exitCode: 0,
			errors: [],
			scaffoldErrors: [],
			consumerErrors: [],
			timedOut: false,
		});

		const result = await auditCmd({ fix: true, verify: true, cwd: dir });

		expect(vi.mocked(runConsumerVerify)).toHaveBeenCalledOnce();
		// A green gate is exit 0 — never the non-zero code reserved for a red gate.
		expect(result.exitCode).toBe(0);
		expect(result.outcome).toBe("success");

		const infoMessages = vi.mocked(info).mock.calls.map((c) => String(c[0]));
		expect(
			infoMessages.find((m) => m.startsWith("No action required") && m.includes("verified")),
			infoMessages.join("\n"),
		).toBeDefined();

		// The retired homework: no "→ Next: run <build>" breadcrumb.
		const nextStepCalls = vi.mocked(printNextStep).mock.calls;
		expect(nextStepCalls.some(([cmd]) => cmd === "audit-fix")).toBe(false);
	});

	it("warns on pre-existing consumer errors but still emits the green verdict", async () => {
		await scaffoldFixtureWithFixableDrift(dir);

		vi.mocked(runConsumerVerify).mockResolvedValue({
			ok: true,
			command: "npx tsc --noEmit",
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
			scaffoldErrors: [],
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
			timedOut: false,
		});

		const result = await auditCmd({ fix: true, verify: true, cwd: dir });

		const infoMessages = vi.mocked(info).mock.calls.map((c) => String(c[0]));
		const noted = infoMessages.find((m) => m.includes("pre-existing consumer error"));
		expect(noted, infoMessages.join("\n")).toBeDefined();

		// Non-zero exit is NOT reserved for consumer errors — they're warn-only.
		expect(result.exitCode).toBe(0);
	});

	it("does NOT call the verify gate on a read-only audit run (no --fix)", async () => {
		await scaffoldFixtureWithFixableDrift(dir);

		await auditCmd({ fix: false, verify: true, cwd: dir });

		expect(vi.mocked(runConsumerVerify)).not.toHaveBeenCalled();
	});

	it("does NOT run the verify gate when the caller omits `verify` (driver/loop-path contract)", async () => {
		await scaffoldFixtureWithFixableDrift(dir);

		// Issue #437: the verify gate is caller-owned and opt-in. The remediation
		// driver runs audit --fix as a plain function without `verify`, so the
		// per-step gate never fires — heal owns the single gate at convergence.
		await auditCmd({ fix: true, cwd: dir });

		expect(vi.mocked(runConsumerVerify)).not.toHaveBeenCalled();
	});
});

// Silence the unused warning when type-importing helpers without using them.
void exists;
