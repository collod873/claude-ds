/**
 * Issue #624 — `formatContent` per-run memoization.
 *
 * The front door re-derives full project state ~6-7× per invocation, and each
 * sweep's generated-integrity scan formats every showcase companion in-memory
 * via `formatContent` — a *synchronous* biome/prettier spawn per file. On a
 * Crewops-sized tree (135 sources) that is ~800 spawns per run.
 *
 * `formatContent` is a pure function of (formatter, content, filePath, cwd):
 * same inputs → same canonical bytes. Memoizing it is therefore semantically
 * transparent — it only removes the redundant respawns across repeated sweeps.
 * These tests pin that: identical input formats once and is served from cache
 * thereafter; distinct content still spawns (the cache is content-addressed,
 * not a blanket short-circuit).
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatContent, type ResolvedFormatter } from "../../src/lib/formatter";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

/**
 * A stdin-aware formatter that records each invocation (one line per spawn into
 * `<name>.calls`) and echoes stdin back as its "formatted" output. The call log
 * is the spawn counter the memoization assertion reads.
 */
async function installRecordingFormatter(dir: string, name: string, exitCode = 0): Promise<string> {
	const binDir = join(dir, "node_modules", ".bin");
	await mkdir(binDir, { recursive: true });
	const calledLog = join(binDir, `${name}.calls`);
	const script = [
		"#!/usr/bin/env bash",
		`echo call >> "${calledLog}"`,
		"cat",
		`exit ${exitCode}`,
	].join("\n");
	const p = join(binDir, name);
	await writeFile(p, script, "utf8");
	await chmod(p, 0o755);
	return calledLog;
}

async function countCalls(log: string): Promise<number> {
	const raw = await readFile(log, "utf8").catch(() => "");
	return raw.split("\n").filter((l) => l.trim().length > 0).length;
}

describe("formatContent — per-run memoization (#624)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir("fmt-memo-");
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("formats identical content once, then serves cached bytes without respawning", async () => {
		const calls = await installRecordingFormatter(dir, "biome");
		const rf: ResolvedFormatter = {
			kind: "biome",
			bin: join(dir, "node_modules", ".bin", "biome"),
		};
		const content = "export const x = 1;\n";
		const path = "design-system/atoms/tag.showcase.tsx";

		const first = formatContent(rf, content, path, dir);
		const second = formatContent(rf, content, path, dir);
		const third = formatContent(rf, content, path, dir);

		// Same canonical bytes every time…
		expect(second).toBe(first);
		expect(third).toBe(first);
		// …but the formatter is spawned exactly once.
		expect(await countCalls(calls)).toBe(1);
	});

	it("re-spawns for different content (cache is content-addressed, not blanket)", async () => {
		const calls = await installRecordingFormatter(dir, "biome");
		const rf: ResolvedFormatter = {
			kind: "biome",
			bin: join(dir, "node_modules", ".bin", "biome"),
		};
		const path = "design-system/atoms/tag.showcase.tsx";

		formatContent(rf, "a\n", path, dir);
		formatContent(rf, "b\n", path, dir);

		expect(await countCalls(calls)).toBe(2);
	});

	it("re-spawns for the same content under a different file path", async () => {
		const calls = await installRecordingFormatter(dir, "biome");
		const rf: ResolvedFormatter = {
			kind: "biome",
			bin: join(dir, "node_modules", ".bin", "biome"),
		};
		const content = "export const x = 1;\n";

		formatContent(rf, content, "design-system/atoms/a.showcase.tsx", dir);
		formatContent(rf, content, "design-system/atoms/b.showcase.tsx", dir);

		expect(await countCalls(calls)).toBe(2);
	});

	it("does NOT cache failures — a non-zero exit re-spawns and never pins a stale fallback", async () => {
		// A formatter that exits non-zero falls through to the original `content`.
		// That fallback must NOT be cached: a transient spawn failure can't be
		// allowed to pin a never-formatted result for the rest of the run. Pin it
		// here so a future "cache the fallback too" tweak can't silently regress.
		const calls = await installRecordingFormatter(dir, "biome", 1);
		const rf: ResolvedFormatter = {
			kind: "biome",
			bin: join(dir, "node_modules", ".bin", "biome"),
		};
		const content = "export const x = 1;\n";
		const path = "design-system/atoms/tag.showcase.tsx";

		expect(formatContent(rf, content, path, dir)).toBe(content);
		expect(formatContent(rf, content, path, dir)).toBe(content);

		// Both calls spawned — the failing result was never memoized.
		expect(await countCalls(calls)).toBe(2);
	});
});
