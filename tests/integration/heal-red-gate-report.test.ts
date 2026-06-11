/**
 * heal's red-gate report gains a state statement, the run ledger, and an off-ramp
 * (PRD #575 / sub-issue #580).
 *
 * When heal converges its own files but the consumer's verify gate fails on a
 * claude-ds-managed file (the plain `verify-failed` branch), the report must,
 * after the scaffold errors, tell the operator three things in order:
 *   1. state statement — was the tree clean at start, and (only then) the exact
 *      `git` command that undoes everything heal wrote;
 *   2. run ledger — the inventory of what heal wrote;
 *   3. off-ramp — determinism ("do not loop"), where to file a claude-ds bug with
 *      the CLI version + pack pin, and the version-pin escape.
 *
 * The clean-at-start path prints the revert command; `--allow-dirty` and no-git
 * paths print the fallback wording explaining why an automatic revert is
 * unavailable. The circular "re-run `claude-ds heal`" advice is gone from this
 * branch (a re-run is deterministic and reproduces the red gate).
 *
 * Mirrors `heal-hand-verify-gate.test.ts`: stub `runConsumerVerify` at the
 * in-process boundary and drive the real convergence loop against an already-clean
 * fixture, then assert heal's exit + report.
 */

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json" with { type: "json" };
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

import { healCmd } from "../../src/commands/heal.js";
import { err, info } from "../../src/lib/log.js";
import { runConsumerVerify, type VerifyResult } from "../../src/lib/run-consumer-verify.js";

const PACK_PIN = "v0.9.0";

/** A red gate on a claude-ds-managed (scaffold) file — the `verify-failed` branch. */
function scaffoldRedGate(): VerifyResult {
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

/** An already-clean adopted tree so the loop converges in one pass to the gate. */
async function cleanAdoptedTree(dir: string): Promise<void> {
	await writeFile(
		join(dir, ".claude-ds.json"),
		JSON.stringify({
			packVersion: PACK_PIN,
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

/** git-init + commit so the clean-tree guard records `state: "clean"`. */
function gitInitAndCommit(d: string): void {
	const opts = { cwd: d, encoding: "utf8" as const };
	spawnSync("git", ["init", "-q"], opts);
	spawnSync("git", ["config", "user.email", "t@t.t"], opts);
	spawnSync("git", ["config", "user.name", "t"], opts);
	spawnSync("git", ["config", "commit.gpgsign", "false"], opts);
	spawnSync("git", ["add", "-A"], opts);
	spawnSync("git", ["commit", "-q", "-m", "init"], opts);
}

describe("heal red-gate report — state statement, ledger, off-ramp (#580)", () => {
	let dir: string;
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		dir = await freshTmpDir("heal-redgate-");
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
		vi.mocked(info).mockClear();
		vi.mocked(err).mockClear();
		vi.mocked(runConsumerVerify).mockReset();
		vi.mocked(runConsumerVerify).mockResolvedValue(scaffoldRedGate());
	});

	afterEach(async () => {
		exitSpy.mockRestore();
		await cleanup(dir);
	});

	const errLines = (): string[] => vi.mocked(err).mock.calls.map((c) => String(c[0]));

	it("clean-at-start: shows scaffold errors → state statement → ledger → off-ramp, in that order", async () => {
		await cleanAdoptedTree(dir);
		gitInitAndCommit(dir);

		await healCmd({ cwd: dir });

		// Red gate on a claude-ds-managed file → exit 1.
		expect(exitSpy).toHaveBeenCalledWith(1);

		const msgs = errLines();
		const idx = (re: RegExp) => msgs.findIndex((m) => re.test(m));
		const scaffold = idx(/verify gate failed/);
		const state = idx(/tree was clean when heal started/);
		const ledger = idx(/What heal wrote this run/);
		const offRamp = idx(/deterministic: a re-run reproduces it/);

		// All four blocks present…
		for (const i of [scaffold, state, ledger, offRamp]) expect(i).toBeGreaterThanOrEqual(0);
		// …and in the order the issue mandates.
		expect(scaffold).toBeLessThan(state);
		expect(state).toBeLessThan(ledger);
		expect(ledger).toBeLessThan(offRamp);
	});

	it("clean-at-start: state statement prints the exact git revert command", async () => {
		await cleanAdoptedTree(dir);
		gitInitAndCommit(dir);

		await healCmd({ cwd: dir });

		const msgs = errLines();
		// The exact, copy-pasteable revert command from the git stash family.
		expect(msgs.some((m) => m.includes("git stash --include-untracked"))).toBe(true);
		// heal prints it but never runs it — git is the transaction layer.
		expect(msgs.some((m) => /heal never runs this for you|transaction layer/i.test(m))).toBe(true);
	});

	it("off-ramp: states determinism, the bug-report destination with CLI version + pack pin, and the version-pin escape", async () => {
		await cleanAdoptedTree(dir);
		gitInitAndCommit(dir);

		await healCmd({ cwd: dir });

		// The pack pin in the report is the tree's current pin (heal's upgrade step
		// may have advanced it) — the coordinate that actually reproduces the gate.
		const pin = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8")).packVersion;

		const msgs = errLines();
		// Determinism — do not loop.
		expect(msgs.some((m) => /deterministic.*re-run|do not loop/i.test(m))).toBe(true);
		// Bug-report destination + both version coordinates.
		expect(msgs.some((m) => m.includes(`/issues`) && m.includes(`v${pkg.version}`))).toBe(true);
		expect(msgs.some((m) => m.includes(pin))).toBe(true);
		// Version-pin escape.
		expect(msgs.some((m) => m.includes("npx claude-ds@<previous>"))).toBe(true);
		// The circular "re-run `claude-ds heal`" advice is gone from this branch.
		expect(msgs.some((m) => /re-run `claude-ds heal`/.test(m))).toBe(false);
	});

	it("--allow-dirty: revert is unavailable; the report says why and falls back to the inventory", async () => {
		await cleanAdoptedTree(dir);
		gitInitAndCommit(dir);

		await healCmd({ cwd: dir, allowDirty: true });

		const msgs = errLines();
		// No automatic revert command on the override path.
		expect(msgs.some((m) => m.includes("git stash --include-untracked"))).toBe(false);
		// Names the override and why revert can't be offered, then defers to the inventory.
		expect(
			msgs.some((m) => /--allow-dirty/.test(m) && /can't separate|no automatic revert/i.test(m)),
		).toBe(true);
		// The ledger block still renders.
		expect(msgs.some((m) => /What heal wrote this run/.test(m))).toBe(true);
	});

	it("no-git: revert is unavailable because there's no transaction layer; falls back to the inventory", async () => {
		// freshTmpDir is not a git repo — the clean-tree guard records `state: "no-git"`.
		await cleanAdoptedTree(dir);

		await healCmd({ cwd: dir });

		const msgs = errLines();
		expect(msgs.some((m) => m.includes("git stash --include-untracked"))).toBe(false);
		expect(msgs.some((m) => /isn't a git repository/i.test(m))).toBe(true);
		expect(msgs.some((m) => /What heal wrote this run/.test(m))).toBe(true);
	});
});
