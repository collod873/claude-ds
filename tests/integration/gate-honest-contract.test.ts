/**
 * The commitment gate's honest three-block contract (#621, PRD #618).
 *
 * The gate that precedes any mutation must read as a status page written for the
 * consumer, not the maintainer. Three blocks, in order:
 *   1. what pressing Enter WILL run — a numbered list of plain-language actions;
 *   2. what it will NOT fix — naming the exact follow-up command for the rest;
 *   3. the prompt — stating the count of steps it runs (never "run all").
 *
 * Internal vocabulary ("pin advance", "reconform", "converging until no drift")
 * never reaches the rendered output — it stays the name in code and docs only.
 * These tests pin the block contract and the new copy from the pure
 * `buildCommitmentGate` render function; the prompt wording is pinned by the
 * interactive front-door contract tests.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCommitmentGate } from "../../src/lib/gate-preview";
import { loadProject } from "../../src/lib/project";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

describe("commitment gate — honest three-block contract (#621)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("block 1 enumerates what Enter runs as a numbered, plain-language list", async () => {
		const ctx = await loadProject(dir);
		const gate = (
			await buildCommitmentGate(ctx, ["sync", "reconform"], {
				classifyCount: 0,
				autoFixableCount: 0,
			})
		).join("\n");

		// Header announces the action, not "I'll bring this tree to clean — N steps".
		expect(gate).toMatch(/Pressing Enter will:/);
		// Numbered actions, one per step, in plan order.
		expect(gate).toMatch(/ 1\. /);
		expect(gate).toMatch(/ 2\. /);
		// Consumer sentences — the reconform step names what it does in plain words.
		expect(gate).toMatch(/regenerate the auto-generated files/);
		// No internal vocabulary leaks.
		expect(gate).not.toMatch(/reconform/);
		expect(gate).not.toMatch(/Converging until no drift/);
		expect(gate).not.toMatch(/pin advance/);
		expect(gate).not.toMatch(/run all/);
	});

	it("block 2 names what Enter won't fix and the exact follow-up command", async () => {
		const ctx = await loadProject(dir);
		const gate = (
			await buildCommitmentGate(
				ctx,
				["sync"],
				{ classifyCount: 0, autoFixableCount: 0 },
				{ completenessCount: 3 },
			)
		).join("\n");

		// The "won't fix" block is present, counts the remainder, and routes it.
		expect(gate).toMatch(/won't fix/i);
		expect(gate).toMatch(/3/);
		expect(gate).toMatch(/claude-ds doctor --completeness/);
		// Plain words — no internal "hand-rolled DS infra" jargon.
		expect(gate).not.toMatch(/hand-rolled DS infra/);
	});

	it("omits the won't-fix block when there is nothing left for completeness", async () => {
		const ctx = await loadProject(dir);
		const gate = (
			await buildCommitmentGate(
				ctx,
				["sync"],
				{ classifyCount: 0, autoFixableCount: 0 },
				{ completenessCount: 0 },
			)
		).join("\n");

		expect(gate).not.toMatch(/won't fix/i);
		expect(gate).not.toMatch(/claude-ds doctor --completeness/);
	});

	it("the three blocks render in order: runs → won't-fix → (prompt is the caller's)", async () => {
		const ctx = await loadProject(dir);
		const gate = (
			await buildCommitmentGate(
				ctx,
				["sync"],
				{ classifyCount: 0, autoFixableCount: 0 },
				{ completenessCount: 2 },
			)
		).join("\n");

		expect(gate.indexOf("Pressing Enter will:")).toBeLessThan(gate.search(/won't fix/i));
	});

	it("an upgrade with no migrations reads in plain words, not 'pin advance (no migrations)'", async () => {
		const cfgPath = join(dir, ".claude-ds.json");
		const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
		// Latest registry version → CLI: no migrations span the gap, only a pin move.
		cfg.packVersion = "v1.0.0";
		await writeFile(cfgPath, JSON.stringify(cfg));
		const ctx = await loadProject(dir);

		const gate = (
			await buildCommitmentGate(ctx, ["upgrade"], { classifyCount: 0, autoFixableCount: 0 })
		).join("\n");

		// The from→to is still visible (the cross-check the dashboard relies on)…
		expect(gate).toMatch(/v1\.0\.0\s*→\s*v/);
		// …but the internal "pin advance (no migrations)" phrasing is gone.
		expect(gate).not.toMatch(/pin advance/);
		expect(gate).not.toMatch(/no migrations/);
	});
});
