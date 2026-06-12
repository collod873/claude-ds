import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { frontDoorCmd } from "../../src/commands/front-door.js";
import { cliVersion } from "../../src/lib/version-vocab.js";
import { type FixtureRun, materializeFixture, runInFixture } from "../helpers/e2e-fixture.js";
import { goldenTranscript } from "../helpers/golden-transcript.js";
import { cleanup } from "../helpers/tmpdir.js";

/**
 * Journey test: heal end-to-end on the time-travel fixture (PRD #529 / sub-issue
 * #538). Materializes the crewops-shaped consumer (adopted at the *previous*
 * published pack version, healed by this CLI) and runs heal across the full
 * loop + verify gate, pinning the #265 fixed-point contract on the cross-version
 * path that produced the Crewops defect register.
 *
 * Assertions are external-behavior only (transcript, exit code, bytes on disk,
 * `.claude-ds.json` state) — never internal call patterns. What it pins:
 *
 *  - #265 contract: heal converges clean, OR exits non-zero naming each remaining
 *    blocker (never a generic/circular failure).
 *  - Defect 1: the upgrade step advances the pack pin from the prior version to
 *    the installed CLI's pack version, even with an empty migration range.
 *  - Defect 2: no pass repeats identically — the upgrade no-op loop is gone, so
 *    the loop reaches the gate instead of churning to the iteration ceiling.
 *  - Defect 9: the front door's status numbers agree with what the loop steps
 *    report (managed-file total, auto-fixable findings, pin advance).
 *
 * Full clean convergence is not reachable offline — the verify gate needs the
 * consumer's installed deps, which install-smoke owns (PRD scope note). So the
 * journey legitimately lands on the named-blocker branch of the #265 contract;
 * the assertions hold regardless of which terminal state the fixture produces.
 *
 * One materialized copy is shared per file: the dashboard capture is read-only
 * (no drive), so it runs on the pre-heal tree before the single heal mutation.
 */

/** Terminal heal exit codes: converged (0), red gate (1), Pending (3), hand-verify (4). */
const KNOWN_TERMINAL_CODES = [0, 1, 3, 4];

/**
 * Render the front-door dashboard on `dir` without driving the loop. `interactive:
 * false` with no `yes` prints the dashboard + commitment-gate preview and stops —
 * it mutates nothing on disk — so it can run on the pre-heal tree. Captures the
 * same stdout stream the integration suite's `captureFrontDoor` does.
 */
async function captureDashboard(dir: string): Promise<string> {
	const origWrite = process.stdout.write.bind(process.stdout);
	const origLog = console.log;
	const origInfo = console.info;
	let out = "";
	const fmt = (args: unknown[]) =>
		`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
	process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
		out += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
		const cb = rest.find((r) => typeof r === "function") as ((err?: Error) => void) | undefined;
		if (cb) cb();
		return true;
	}) as typeof process.stdout.write;
	console.log = (...args: unknown[]) => {
		out += fmt(args);
	};
	console.info = (...args: unknown[]) => {
		out += fmt(args);
	};
	try {
		await frontDoorCmd({ cwd: dir, interactive: false });
	} finally {
		process.stdout.write = origWrite as typeof process.stdout.write;
		console.log = origLog;
		console.info = origInfo;
	}
	return out;
}

describe("journey: heal end-to-end on the time-travel fixture (#538)", () => {
	let dir: string;
	let pinnedBefore: string;
	let dashboard: string;
	let heal: FixtureRun;
	let pinnedAfter: string;

	beforeAll(async () => {
		dir = await materializeFixture("crewops-shaped");
		pinnedBefore = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8")).packVersion;
		// Read-only dashboard FIRST (no drive, no mutation), then the single heal run.
		dashboard = await captureDashboard(dir);
		heal = await runInFixture(dir, ["heal"]);
		pinnedAfter = (JSON.parse(heal.tree[".claude-ds.json"]) as { packVersion: string }).packVersion;
	}, 120000);

	afterAll(async () => {
		await cleanup(dir);
	});

	it("upholds the #265 contract: converges clean, or exits non-zero naming each blocker", () => {
		expect(KNOWN_TERMINAL_CODES).toContain(heal.code);
		const combined = heal.stdout + heal.stderr;

		if (heal.code === 0) {
			expect(heal.stdout).toMatch(/converged in \d+ iteration/);
			return;
		}

		// Non-zero: every remaining blocker is named by file:line:col + TS code, and
		// the count of named blockers equals the count the gate advertises (capped at
		// the gate's 20-line ceiling). The defect this guards: a non-zero exit with a
		// generic "some errors remain" and nothing actionable named.
		const advertised = Number(
			(combined.match(/reported (\d+) error/) ?? combined.match(/(\d+) hand-verify blocker/))?.[1],
		);
		expect(Number.isFinite(advertised)).toBe(true);
		expect(advertised).toBeGreaterThan(0);
		const blockerLines = combined.match(/\S+:\d+:\d+\s+TS\d+/g) ?? [];
		expect(blockerLines.length).toBe(Math.min(advertised, 20));

		// Parting guidance is never the circular "run audit, then re-run" (defect 8):
		// claude-ds either owns the fix or the file is the consumer's to verify — both
		// are actionable, neither loops back to the same dead end.
		expect(combined).not.toMatch(/run\s+`?claude-ds audit`?,?\s*then re-run/i);
	});

	it("advances the pack pin from the prior version to the installed CLI's pack version (defect 1)", () => {
		// The fixture is pinned behind the CLI with an empty migration range — the
		// exact shape that produced the Crewops "upgrade prints ✔ but pin stays put"
		// no-op. The pin must actually move.
		expect(pinnedBefore).not.toBe(cliVersion());
		expect(pinnedAfter).not.toBe(pinnedBefore);
		expect(pinnedAfter).toBe(cliVersion());

		// And the step reports the advance it made, with the same from→to the
		// dashboard previewed.
		const healAdvance = heal.stdout.match(/pin advanced (v[\d.]+)\s*→\s*(v[\d.]+)/);
		expect(healAdvance).not.toBeNull();
		expect(healAdvance?.[1]).toBe(pinnedBefore);
		expect(healAdvance?.[2]).toBe(pinnedAfter);
	});

	it("does not repeat an identical pass — the loop reaches the gate, never churns to the ceiling (defect 2)", () => {
		// Split the transcript on the per-pass marker; each segment is a pass body
		// (its plan string + everything that pass emitted). A no-op pass that changed
		// and cleared nothing would emit a byte-identical body to the pass before it —
		// the defect-2 signature. At least one pass must have run.
		const segments = heal.stdout.split(/heal: pass \d+\/\d+ \(max\) — /).slice(1);
		expect(segments.length).toBeGreaterThanOrEqual(1);
		for (let i = 1; i < segments.length; i++) {
			expect(segments[i]).not.toBe(segments[i - 1]);
		}

		// Defect 1 fixed ⇒ the upgrade complaint clears in pass 1 and the loop settles
		// at the verify gate; it must never exhaust the iteration ceiling.
		expect(heal.stdout + heal.stderr).not.toMatch(/did not converge after \d+ iterations/);
	});

	it("front-door status numbers agree with what the loop steps report (defect 9)", () => {
		// Managed-file total: the dashboard counts present/total before sync; heal's
		// closing line counts them after. The denominator (the managed-file universe)
		// is the same number on both sides.
		const dashTotal = dashboard.match(/Managed files:\s*\d+\/(\d+)/)?.[1];
		const healTotal = heal.stdout.match(/Managed files:\s*\d+\/(\d+)/)?.[1];
		expect(dashTotal).toBeDefined();
		expect(healTotal).toBe(dashTotal);

		// Auto-fixable findings: the dashboard's audit --fix preview advertises a
		// count; the loop's audit --fix step reports fixing that many. The Crewops
		// miss was advertised findings silently dropping out of the plan.
		const dashFindings = dashboard.match(/auto-repair (\d+) finding/)?.[1];
		const healFixed = heal.stdout.match(/fix summary:\s*(\d+) fixed/)?.[1];
		expect(dashFindings).toBeDefined();
		expect(healFixed).toBe(dashFindings);
		// The closing managed-file line restates the same fixed count.
		expect(heal.stdout.match(/Fixed:\s*(\d+)/)?.[1]).toBe(dashFindings);

		// Pin advance: the dashboard previews the same from→to the upgrade step runs.
		const dashAdvance = dashboard.match(/pin advance (v[\d.]+)\s*→\s*(v[\d.]+)/);
		expect(dashAdvance).not.toBeNull();
		expect(dashAdvance?.[1]).toBe(pinnedBefore);
		expect(dashAdvance?.[2]).toBe(pinnedAfter);
	});

	// Golden transcripts (#539): the verbatim bytes of the journey, snapshotted
	// as plain vitest snapshot files. The committed `.snap` is the artifact — any
	// change to user-facing output becomes a reviewable diff; deliberate changes
	// are re-goldened with `vitest -u` in the same PR. Normalized for the three
	// machine-volatile token classes (paths, versions, durations) so the snapshot
	// is identical on any machine and release; see `golden-transcript.ts`.
	it("golden: the dashboard preview matches its committed snapshot", () => {
		const golden = goldenTranscript("(front door — dashboard preview)", 0, dashboard, {
			dir,
			prevVersion: pinnedBefore,
		});
		expect(golden).toMatchSnapshot();
	});

	it("golden: the heal transcript matches its committed snapshot", () => {
		const golden = goldenTranscript("heal", heal.code, heal.transcript, {
			dir,
			prevVersion: pinnedBefore,
		});
		expect(golden).toMatchSnapshot();
	});
});
