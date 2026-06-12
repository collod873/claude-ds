/**
 * Issue #414 / C4 — tier-summary rendering for mutating commands.
 *
 * Where `renderChangeSummary` is the verbose one-line-per-file shape (kept for
 * `--verbose`), `renderChangeTierSummary` is the default-quiet collapse:
 *   "added meta.kind to 90 files: 45 atoms, 45 composites"
 *   "rewrote imports in 34 files (atoms/composites)"
 *   "restored 6 managed scaffold files"
 *
 * Pure — no I/O, no color. Assertions run against the raw `string[]` so the
 * non-TTY agent surface is byte-identical to TTY (color is the only difference).
 */
import { describe, expect, it } from "vitest";
import type { Change } from "../../../src/lib/operation.js";
import { renderChangeTierSummary, type SummaryEntry } from "../../../src/lib/render/index.js";

function write(path: string, before: string | null, after: string): Change {
	return {
		kind: "write",
		path,
		before: before === null ? null : Buffer.from(before, "utf8"),
		after: Buffer.from(after, "utf8"),
	};
}

function del(path: string, before: string): Change {
	return { kind: "delete", path, before: Buffer.from(before, "utf8") };
}

function abort(path: string, reason: string): Change {
	return { kind: "abort", path, reason };
}

describe("renderChangeTierSummary", () => {
	it("returns 'No changes.' on empty input", () => {
		expect(renderChangeTierSummary([])).toEqual(["No changes."]);
	});

	it("groups DS file writes by tier", () => {
		const entries: SummaryEntry[] = [];
		for (let i = 0; i < 45; i++) {
			entries.push({
				opName: "metaKindFixer",
				change: write(`design-system/atoms/atom-${i}.tsx`, "old\n", "new\n"),
			});
		}
		for (let i = 0; i < 45; i++) {
			entries.push({
				opName: "metaKindFixer",
				change: write(`design-system/composites/comp-${i}.tsx`, "old\n", "new\n"),
			});
		}
		const lines = renderChangeTierSummary(entries);
		expect(lines.some((l) => /90 files modified.*45 atoms.*45 composites/.test(l))).toBe(true);
	});

	it("collapses scaffold writes (managed pack files outside tier dirs)", () => {
		const entries: SummaryEntry[] = [
			{ opName: "syncPackFiles", change: write("design-system/tokens.json", null, "{}\n") },
			{ opName: "syncPackFiles", change: write(".claude/hooks/check-imports.ts", null, "x\n") },
			{ opName: "syncPackFiles", change: write("design-system/contracts/role.ts", null, "y\n") },
		];
		const lines = renderChangeTierSummary(entries);
		expect(lines.some((l) => /3 scaffold files/.test(l))).toBe(true);
	});

	it("surfaces config-flag flips first, separately from tier counts", () => {
		const before = JSON.stringify({ pack: "next-react", meta_kind_strict: false }, null, 2);
		const after = JSON.stringify({ pack: "next-react", meta_kind_strict: true }, null, 2);
		const entries: SummaryEntry[] = [
			{ opName: "meta-kind-hard", change: write(".claude-ds.json", before, after) },
			{ opName: "metaKindFixer", change: write("design-system/atoms/foo.tsx", "old\n", "new\n") },
		];
		const lines = renderChangeTierSummary(entries);
		expect(lines[0]).toBe("Substantive changes:");
		expect(lines.some((l) => l.includes("meta_kind_strict: false -> true"))).toBe(true);
		expect(lines.some((l) => /1 file modified.*1 atom/.test(l))).toBe(true);
	});

	it("surfaces a version pin as `pack pinned <from> → <to>` (#591)", () => {
		const before = JSON.stringify({ pack: "next-react", packVersion: "v1.0.0" }, null, 2);
		const after = JSON.stringify({ pack: "next-react", packVersion: "v1.4.0" }, null, 2);
		const entries: SummaryEntry[] = [
			{ opName: "finalizeUpgrade", change: write(".claude-ds.json", before, after) },
		];
		const lines = renderChangeTierSummary(entries);
		expect(lines[0]).toBe("Substantive changes:");
		expect(lines).toContain("! .claude-ds.json  pack pinned v1.0.0 → v1.4.0");
		expect(lines.some((l) => l.includes("config flag"))).toBe(false);
	});

	it("collapses aborts to a count", () => {
		const entries: SummaryEntry[] = [
			{ opName: "syncPackFiles", change: write("design-system/atoms/foo.tsx", "old\n", "new\n") },
			{
				opName: "syncPackFiles",
				change: abort("design-system/atoms/bar.tsx", "hand-edited managed file"),
			},
			{
				opName: "syncPackFiles",
				change: abort("design-system/atoms/baz.tsx", "hand-edited managed file"),
			},
		];
		const lines = renderChangeTierSummary(entries);
		expect(lines.some((l) => /Skipped: 2 files/.test(l))).toBe(true);
	});

	it("singularizes counts for one file", () => {
		const entries: SummaryEntry[] = [
			{ opName: "syncPackFiles", change: write("design-system/atoms/foo.tsx", "old\n", "new\n") },
		];
		const lines = renderChangeTierSummary(entries);
		expect(lines.some((l) => /1 file modified.*1 atom\b/.test(l))).toBe(true);
		// No plural "atoms" or "files" for n=1.
		expect(lines.some((l) => /1 atoms/.test(l) || /1 files/.test(l))).toBe(false);
	});

	it("buckets adds, modifies, deletes, renames separately within the tier summary", () => {
		const entries: SummaryEntry[] = [
			{ opName: "x", change: write("design-system/atoms/added.tsx", null, "new\n") },
			{ opName: "x", change: write("design-system/atoms/modified.tsx", "old\n", "new\n") },
			{ opName: "x", change: del("design-system/atoms/deleted.tsx", "old\n") },
		];
		const lines = renderChangeTierSummary(entries);
		expect(lines.some((l) => /added/.test(l))).toBe(true);
		expect(lines.some((l) => /modified/.test(l))).toBe(true);
		expect(lines.some((l) => /deleted/.test(l))).toBe(true);
	});

	it("is pure — calling twice returns equal arrays", () => {
		const entries: SummaryEntry[] = [
			{ opName: "op", change: write("design-system/atoms/a.tsx", "x\n", "y\n") },
		];
		expect(renderChangeTierSummary(entries)).toEqual(renderChangeTierSummary(entries));
	});
});
