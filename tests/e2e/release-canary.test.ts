import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { materializeFixture, runInFixture } from "../helpers/e2e-fixture.js";
import { cleanup, freshTmpDir } from "../helpers/tmpdir.js";

/**
 * Release canary assertion logic (PRD #546 / sub-issue #556).
 *
 * The canary itself clones a real consumer, installs the candidate tarball, and
 * heals it — a network, release-time step that stays out of CI and `npm test`.
 * What this pins OFFLINE is the script's `--evaluate` half: the verdict logic
 * that decides whether a heal run cleared the release contract (exit 0 + green
 * verify gate + idempotent second run). It is driven two ways:
 *
 *   - against the committed time-travel fixture's REAL heal `--json` output, so
 *     the failure-naming path is exercised on a true red gate, and
 *   - against synthetic green / idempotence envelopes, covering the pass path
 *     and the second-run-mutated path the offline fixture can't reach (its
 *     verify gate fails on the consumer's own un-installed deps).
 *
 * Mirrors `refresh-time-travel-fixture.test.ts`: spawn the release-time script
 * in its offline mode and assert the verdict, no network.
 */

const SCRIPT = fileURLToPath(new URL("../../scripts/release-canary.mjs", import.meta.url));

function evaluate(files: string[]) {
	const res = spawnSync("node", [SCRIPT, "--evaluate", ...files], { encoding: "utf8" });
	return { code: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

/** A passing heal `--json` envelope: fully converged, verify gate green. */
const CONVERGED = JSON.stringify({
	command: "heal",
	ok: true,
	verdict: "converged",
	exitCode: 0,
	actions: { iterations: 1, maxIterations: 3 },
	remaining: { findingsCount: 0, pending: 0, verify: { ok: true } },
});

describe("release canary: --evaluate verdict (#556)", () => {
	describe("offline, against the committed time-travel fixture", () => {
		let dir: string;
		let run1File: string;

		beforeAll(async () => {
			dir = await materializeFixture("crewops-shaped");
			const heal = await runInFixture(dir, ["heal", "--json"]);
			run1File = join(await freshTmpDir("canary-run1-"), "run1.json");
			await writeFile(run1File, heal.stdout);
		}, 120000);

		afterAll(async () => {
			await cleanup(dir);
		});

		it("fails on the fixture's red verify gate and names each blocking error", () => {
			const { code, out } = evaluate([run1File]);
			// The fixture's verify gate is red offline — the canary must fail (non-zero)…
			expect(code).not.toBe(0);
			expect(out).toMatch(/FAIL/);
			// …and name the blockers with file:line:col + TS code, never a generic message.
			expect(out).toMatch(/first heal: \S+:\d+:\d+\s+TS\d+:/);
		});
	});

	describe("on synthetic envelopes", () => {
		let tmp: string | undefined;
		afterEach(async () => {
			if (tmp) await cleanup(tmp);
			tmp = undefined;
		});
		const write = async (name: string, body: string) => {
			tmp = tmp ?? (await freshTmpDir("canary-synth-"));
			const p = join(tmp, name);
			await writeFile(p, body);
			return p;
		};

		it("passes when both runs converge green and the second is a no-op", async () => {
			const a = await write("a.json", CONVERGED);
			const b = await write("b.json", CONVERGED);
			const { code, out } = evaluate([a, b]);
			expect(code).toBe(0);
			expect(out).toMatch(/PASS/);
		});

		it("fails idempotence when the second run mutated the tree", async () => {
			const a = await write("a.json", CONVERGED);
			const b = await write("b.json", CONVERGED);
			const { code, out } = evaluate([a, b, "--dirty"]);
			expect(code).not.toBe(0);
			expect(out).toMatch(/not idempotent/i);
		});

		it("fails idempotence when the second run does not converge", async () => {
			const a = await write("a.json", CONVERGED);
			const b = await write(
				"b.json",
				JSON.stringify({
					command: "heal",
					ok: false,
					verdict: "verify-failed",
					exitCode: 1,
					actions: {},
					remaining: {
						verify: {
							scaffoldErrors: [
								{
									file: "design-system/atoms/x.tsx",
									line: 3,
									col: 1,
									code: "TS2322",
									message: "boom",
								},
							],
						},
					},
				}),
			);
			const { code, out } = evaluate([a, b]);
			expect(code).not.toBe(0);
			expect(out).toMatch(
				/second heal \(idempotence\): design-system\/atoms\/x\.tsx:3:1\s+TS2322:/,
			);
		});

		it("names the pending decisions when the first heal exits pending", async () => {
			const a = await write(
				"a.json",
				JSON.stringify({
					command: "heal",
					ok: false,
					verdict: "pending",
					exitCode: 3,
					actions: {},
					remaining: { pending: 1, decisions: [{ id: "DEC-1", question: "which tier?" }] },
				}),
			);
			const { code, out } = evaluate([a]);
			expect(code).not.toBe(0);
			expect(out).toMatch(/pending decision DEC-1 — which tier\?/);
		});
	});
});
