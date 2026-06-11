/**
 * heal's verify gate partitions errors by ownership and names a second partial
 * fixed point (issue #537 / ADR-0030; Crewops defects 7 + 8).
 *
 * Two routings, both at the converged-tree gate:
 *
 *  - Defect 7: an error in a `@generated` file is a **claude-ds defect**, not
 *    hand-verify. heal red-gates (exit 1) and the parting guidance says claude-ds
 *    owns it / do not hand-edit `@generated` — never "verify by hand," which the
 *    header forbids and re-running can't converge.
 *  - Defect 8: when the *only* blockers are consumer-authored hand-verify errors
 *    (bytes stable, claude-ds's own files clean), heal exits on a distinct named
 *    code (`HEAL_EXIT_HAND_VERIFY` = 4) and names each file — never the circular
 *    "run audit, then re-run" that can't converge here.
 *
 * Mirrors `verify-gate.test.ts` / `front-door-verify-gate.test.ts`: stub
 * `runConsumerVerify` at the in-process boundary and drive the real convergence
 * loop against an already-clean fixture, then assert heal's exit + guidance.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, freshTmpDir } from "../helpers/tmpdir.js";

vi.mock("../../src/lib/log.js", async () => {
	const actual =
		await vi.importActual<typeof import("../../src/lib/log.js")>("../../src/lib/log.js");
	return { ...actual, info: vi.fn(), err: vi.fn() };
});

vi.mock("../../src/lib/run-consumer-verify.js", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/run-consumer-verify.js")>(
		"../../src/lib/run-consumer-verify.js",
	);
	return { ...actual, runConsumerVerify: vi.fn() };
});

import { HEAL_EXIT_HAND_VERIFY, healCmd } from "../../src/commands/heal.js";
import { err, info } from "../../src/lib/log.js";
import { runConsumerVerify, type VerifyResult } from "../../src/lib/run-consumer-verify.js";

/** A green gate — claude-ds's files type-check, no blockers. */
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

/** An already-clean adopted tree so the loop converges in one pass to the gate. */
async function cleanAdoptedTree(dir: string): Promise<void> {
	await writeFile(
		join(dir, ".claude-ds.json"),
		JSON.stringify({
			packVersion: "v0.9.0",
			pack: "next-react",
			mode: "warn",
			domain_roots: ["features", "lib"],
			ds_aliases: ["@ds"],
		}),
	);
	await mkdir(join(dir, "design-system/atoms"), { recursive: true });
	await mkdir(join(dir, "design-system/composites"), { recursive: true });
	await writeFile(
		join(dir, "design-system/atoms/button.tsx"),
		`export function Button() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
	);
}

describe("heal verify gate — ownership partition + hand-verify fixed point (#537)", () => {
	let dir: string;
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		dir = await freshTmpDir("heal-handverify-");
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
		vi.mocked(info).mockClear();
		vi.mocked(err).mockClear();
		vi.mocked(runConsumerVerify).mockReset();
		vi.mocked(runConsumerVerify).mockResolvedValue(greenVerify());
	});

	afterEach(async () => {
		exitSpy.mockRestore();
		await cleanup(dir);
	});

	it("defect 8: hand-verify-only blockers exit on the named code with per-file, non-circular guidance", async () => {
		await cleanAdoptedTree(dir);
		const handVerifyError = {
			file: "design-system/atoms/card.stories.tsx",
			line: 4,
			col: 9,
			code: "TS2322",
			message: "JSX example does not type-check.",
			raw: "",
		};
		vi.mocked(runConsumerVerify).mockResolvedValue(
			greenVerify({ exitCode: 1, errors: [handVerifyError], handVerifyErrors: [handVerifyError] }),
		);

		await healCmd({ cwd: dir });

		// Named partial fixed point — distinct from convergence (0) and red gate (1).
		expect(exitSpy).toHaveBeenCalledWith(HEAL_EXIT_HAND_VERIFY);
		expect(exitSpy).not.toHaveBeenCalledWith(1);

		const errMsgs = vi.mocked(err).mock.calls.map((c) => String(c[0]));
		// Names the specific blocker by file + code (defect 8: never generic).
		expect(errMsgs.some((m) => m.includes("card.stories.tsx"))).toBe(true);
		expect(errMsgs.some((m) => m.includes("TS2322"))).toBe(true);
		// Guidance is hand-verify-shaped, not the circular "run audit, then re-run."
		expect(errMsgs.some((m) => /hand-verify|by hand|yours to fix/i.test(m))).toBe(true);
		expect(errMsgs.some((m) => /run .*audit.*then re-run|run `claude-ds audit`/i.test(m))).toBe(
			false,
		);
		// Did not falsely declare convergence.
		const infoMsgs = vi.mocked(info).mock.calls.map((c) => String(c[0]));
		expect(infoMsgs.some((m) => /converged in \d+ iteration\(s\) — 0 changes/.test(m))).toBe(false);
	});

	it("defect 7: an error in a @generated file red-gates as a claude-ds defect, not hand-verify", async () => {
		await cleanAdoptedTree(dir);
		const generatedError = {
			file: "design-system/atoms/combobox.showcase.tsx",
			line: 2,
			col: 30,
			code: "TS2322",
			message: "Property 'size' does not exist.",
			raw: "",
		};
		// ADR-0030: claude-ds wrote this file; the partition keeps it in scaffold.
		vi.mocked(runConsumerVerify).mockResolvedValue(
			greenVerify({
				ok: false,
				exitCode: 1,
				errors: [generatedError],
				scaffoldErrors: [generatedError],
			}),
		);

		await healCmd({ cwd: dir });

		// Red gate (1), never the hand-verify exit — the header forbids editing it.
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(exitSpy).not.toHaveBeenCalledWith(HEAL_EXIT_HAND_VERIFY);

		const errMsgs = vi.mocked(err).mock.calls.map((c) => String(c[0]));
		expect(errMsgs.some((m) => m.includes("combobox.showcase.tsx"))).toBe(true);
		// Non-circular, ownership-correct guidance: claude-ds's to fix; don't hand-edit @generated.
		expect(errMsgs.some((m) => /@generated/.test(m))).toBe(true);
		expect(errMsgs.some((m) => /claude-ds('s| is| owns)/i.test(m))).toBe(true);
		// Crucially NOT routed to "verify by hand."
		expect(errMsgs.some((m) => /verify (it|each|them)? ?by hand|hand-verify/i.test(m))).toBe(false);
	});

	it("green gate: clean verify converges and exits 0 (no hand-verify, no red gate)", async () => {
		await cleanAdoptedTree(dir);
		vi.mocked(runConsumerVerify).mockResolvedValue(greenVerify());

		await healCmd({ cwd: dir });

		expect(exitSpy).not.toHaveBeenCalledWith(1);
		expect(exitSpy).not.toHaveBeenCalledWith(HEAL_EXIT_HAND_VERIFY);
		const infoMsgs = vi.mocked(info).mock.calls.map((c) => String(c[0]));
		expect(infoMsgs.some((m) => /converged/.test(m))).toBe(true);
	});
});
