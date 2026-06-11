import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	commitTree,
	type FixtureRun,
	gitChangedPaths,
	materializeFixture,
	runInFixture,
} from "../helpers/e2e-fixture.js";
import { cleanup } from "../helpers/tmpdir.js";

/**
 * End-to-end convergence invariants (PRD #575 / sub-issue #583) on the
 * time-travel fixture — the crewops-shaped consumer adopted at the previous pack
 * version. The journey test (#538) pins that heal lands on a named-blocker red
 * gate offline; these two invariants pin what must stay true *across* that gate:
 *
 *  1. Anti-circularity: a second heal run from the same red gate exits with the
 *     identical verdict and the identical error set. A future circular-remediation
 *     regression — where re-running heal churns the tree and shifts the verdict or
 *     the named blockers — fails CI here instead of shipping.
 *
 *  2. Trusted inventory: heal's reported `filesWritten` ledger never lies about
 *     what hit disk. Checked in two directions, because the ledger today records
 *     only steps that return a RunReport (full step coverage is a later PRD-#575
 *     slice — see remediation-driver), so a first-run ledger is a *subset* of the
 *     tree diff, not yet its mirror:
 *       - run 1 (subset): every path the ledger claims is genuinely changed on
 *         disk — the inventory never fabricates a write.
 *       - run 2 (equality): on the converged no-op re-run the ledger must equal
 *         the tree diff exactly — a step writing outside its RunReport would put
 *         bytes on disk the ledger omits and break this.
 *     Asserted via the headless JSON field (the prose ledger renders the same
 *     data), so the check is robust to wording.
 *
 * Assertions are external-behavior only: exit code, headless envelope, and the
 * git tree diff. Both invariants share one fixture: run heal (red gate), commit
 * the writes the way a consumer/CI would, then re-run heal from the clean repo.
 */

/** The verify-failed / exhausted envelopes ship the JSON after a few chatter lines. */
function envelope(stdout: string): {
	verdict: string;
	remaining: {
		filesWritten?: string[];
		verify?: {
			scaffoldErrors?: Array<{ file: string; line: number; col: number; code: string }>;
			handVerifyErrors?: Array<{ file: string; line: number; col: number; code: string }>;
		};
	};
} {
	const start = stdout.indexOf("{");
	if (start === -1) throw new Error(`no headless envelope on stdout:\n${stdout}`);
	return JSON.parse(stdout.slice(start));
}

/** The gate's blocker set as stable `file:line:col code` keys, sorted. */
function errorSet(env: ReturnType<typeof envelope>): string[] {
	const v = env.remaining.verify ?? {};
	return [...(v.scaffoldErrors ?? []), ...(v.handVerifyErrors ?? [])]
		.map((e) => `${e.file}:${e.line}:${e.col} ${e.code}`)
		.sort();
}

describe("e2e: heal convergence invariants on the time-travel fixture (#583)", () => {
	let dir: string;
	let first: FixtureRun;
	let firstDiff: string[];
	let second: FixtureRun;
	let secondDiff: string[];

	beforeAll(async () => {
		dir = await materializeFixture("crewops-shaped");
		// First heal: drives the loop and lands on the offline red verify gate.
		first = await runInFixture(dir, ["heal", "--json"]);
		firstDiff = gitChangedPaths(dir);
		// Commit the run's writes the way a consumer/CI would before re-running —
		// heal's clean-tree guard aborts on a dirty tree.
		commitTree(dir, "after first heal");
		// Second heal from the clean repo: the converged-modulo-gate re-run.
		second = await runInFixture(dir, ["heal", "--json"]);
		secondDiff = gitChangedPaths(dir);
	}, 180000);

	afterAll(async () => {
		await cleanup(dir);
	});

	it("red gate → a second heal run exits with the identical verdict and error set", () => {
		// Precondition: the first run actually hit the red verify gate (exit 1),
		// the branch this invariant guards. If the fixture ever converges clean
		// offline this guard is moot — fail loudly so the test is re-pointed.
		expect(first.code).toBe(1);
		const firstEnv = envelope(first.stdout);
		expect(firstEnv.verdict).toBe("verify-failed");
		expect(errorSet(firstEnv).length).toBeGreaterThan(0);

		// The invariant: the second run is byte-for-byte the same verdict over the
		// same blockers — no circular remediation shifted either.
		expect(second.code).toBe(first.code);
		const secondEnv = envelope(second.stdout);
		expect(secondEnv.verdict).toBe(firstEnv.verdict);
		expect(errorSet(secondEnv)).toEqual(errorSet(firstEnv));
	});

	it("reported filesWritten mirrors the run's actual tree diff", () => {
		// Direction 1 (non-degenerate): every path the first run's ledger claims it
		// wrote is genuinely changed on disk — the inventory never fabricates a
		// write. The red gate runs after the loop mutated the tree, so there is at
		// least one real entry to check.
		const firstWritten = envelope(first.stdout).remaining.filesWritten ?? [];
		expect(firstWritten.length).toBeGreaterThan(0);
		for (const path of firstWritten) {
			expect(firstDiff).toContain(path);
		}

		// Direction 2 (full equality): the second run is a fixed point on the tree
		// — committing the first run's writes leaves nothing for heal to redo — so
		// its reported inventory must exactly equal its actual tree diff. A step
		// writing outside its RunReport would put bytes on disk that the ledger
		// omits, breaking this equality.
		const secondWritten = envelope(second.stdout).remaining.filesWritten ?? [];
		expect([...secondWritten].sort()).toEqual(secondDiff);
	});
});
