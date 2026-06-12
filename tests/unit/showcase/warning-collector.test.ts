/**
 * Issue #619 / PRD #618 — the structured generator-warning channel.
 *
 * The showcase generator routes its internal `[AST]` skip warnings through a
 * collector instead of writing raw stderr. The collector dedupes across the
 * whole front-door invocation (keyed on the source file, so the ~7 generator
 * sweeps per run count once), surfaces a single consumer-language summary line
 * when warnings exist, the full itemized list under `--verbose`, and nothing
 * at all when zero warnings were collected.
 */
import { describe, expect, it } from "vitest";
import { GeneratorWarningCollector } from "../../../src/lib/showcase/warning-collector.js";

describe("GeneratorWarningCollector", () => {
	it("is silent when nothing was collected", () => {
		const c = new GeneratorWarningCollector();
		expect(c.isEmpty).toBe(true);
		expect(c.summaryLine()).toBeNull();
		expect(c.render({})).toEqual([]);
		expect(c.render({ verbose: true })).toEqual([]);
	});

	it("collects per-source warnings into a count + summary line", () => {
		const c = new GeneratorWarningCollector();
		c.beginSource("payment-summary.tsx");
		c.warn("spread-object", "spread in object — skipping");
		c.warn("spread-object", "spread in object — skipping");
		c.warn("spread-object", "spread in object — skipping");
		c.warn("spread-object", "spread in object — skipping");

		expect(c.isEmpty).toBe(false);
		expect(c.total).toBe(4);
		expect(c.fileCount).toBe(1);
		expect(c.summaryLine()).toBe(
			"4 component examples couldn't be parsed and were skipped (1 file) — these need your eye:",
		);
	});

	it("uses singular phrasing for a single skipped example", () => {
		const c = new GeneratorWarningCollector();
		c.beginSource("badge.tsx");
		c.warn("computed-key", "computed property key — skipping");
		expect(c.summaryLine()).toBe(
			"1 component example couldn't be parsed and was skipped (1 file) — these need your eye:",
		);
	});

	it("dedupes identical sweeps across the whole invocation (keyed on file)", () => {
		const c = new GeneratorWarningCollector();
		// The same file regenerated across 7 sweeps emits the same 4 warnings each
		// time. They must count once — "4 examples in 1 file", not 28.
		for (let sweep = 0; sweep < 7; sweep++) {
			c.beginSource("payment-summary.tsx");
			for (let i = 0; i < 4; i++) c.warn("spread-object", "spread in object — skipping");
		}
		expect(c.total).toBe(4);
		expect(c.fileCount).toBe(1);
	});

	it("keeps warnings from distinct files separate", () => {
		const c = new GeneratorWarningCollector();
		c.beginSource("payment-summary.tsx");
		c.warn("spread-object", "spread in object — skipping");
		c.warn("spread-object", "spread in object — skipping");
		c.beginSource("data-table.tsx");
		c.warn("unresolved-identifier", 'unresolved identifier "cols" — dropping value');
		expect(c.total).toBe(3);
		expect(c.fileCount).toBe(2);
	});

	it("itemizes the full per-file list under --verbose, naming the source file", () => {
		const c = new GeneratorWarningCollector();
		c.beginSource("payment-summary.tsx");
		c.warn("spread-object", "spread in object — skipping");
		c.warn("spread-object", "spread in object — skipping");

		const lines = c.render({ verbose: true });
		// Every skipped example is itemized with its source file and AST detail.
		const detailLines = lines.filter((l) => l.includes("spread in object"));
		expect(detailLines).toHaveLength(2);
		expect(detailLines.every((l) => l.includes("payment-summary.tsx"))).toBe(true);
		// The collapsing `--verbose` hint never appears in the itemized list.
		expect(lines.some((l) => l.includes("re-run with --verbose"))).toBe(false);
	});

	it("names the affected files without --verbose and states the audit blind spot (#643)", () => {
		const c = new GeneratorWarningCollector();
		c.beginSource("payment-summary.tsx");
		for (let i = 0; i < 4; i++) c.warn("spread-object", "spread in object — skipping");
		c.beginSource("data-table.tsx");
		c.warn("unresolved-identifier", 'unresolved identifier "cols" — dropping value');

		const lines = c.render({});
		const text = lines.join("\n");
		// Count + file count, without --verbose.
		expect(text).toContain("5 component examples");
		expect(text).toContain("2 files");
		// Both affected files named — no --verbose required.
		expect(text).toContain("payment-summary.tsx");
		expect(text).toContain("data-table.tsx");
		// The consequence copy: skipped → excluded from audit, still compiled by
		// verify, so it can hide type errors (the owner's reason, asserted as a string).
		expect(text).toContain("excluded from audit");
		expect(text).toContain("still compiled by your verify");
		expect(text).toContain("hide type errors");
		// The non-verbose section does NOT spill the raw per-skip AST detail.
		expect(text).not.toContain("spread in object");
		// No longer an orphaned "re-run with --verbose for details" floating line.
		expect(text).not.toContain("re-run with --verbose for details");
	});

	it("attributes the section to its hand-verify owner (need your eye), not an orphaned line", () => {
		const c = new GeneratorWarningCollector();
		c.beginSource("badge.tsx");
		c.warn("computed-key", "computed property key — skipping");
		const text = c.render({}).join("\n");
		expect(text).toContain("need your eye");
	});

	it("ignores warnings emitted with no active source (defensive)", () => {
		const c = new GeneratorWarningCollector();
		c.warn("spread-object", "spread in object — skipping");
		expect(c.isEmpty).toBe(true);
	});
});
