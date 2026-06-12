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
			"4 component examples couldn't be parsed and were skipped — re-run with --verbose for details",
		);
	});

	it("uses singular phrasing for a single skipped example", () => {
		const c = new GeneratorWarningCollector();
		c.beginSource("badge.tsx");
		c.warn("computed-key", "computed property key — skipping");
		expect(c.summaryLine()).toBe(
			"1 component example couldn't be parsed and was skipped — re-run with --verbose for details",
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
		// Every skipped example is listed, and each line names the source file.
		const fileLines = lines.filter((l) => l.includes("payment-summary.tsx"));
		expect(fileLines).toHaveLength(2);
		expect(fileLines.every((l) => l.includes("spread in object"))).toBe(true);
		// The collapsing `--verbose` hint never appears in the itemized list.
		expect(lines.some((l) => l.includes("re-run with --verbose"))).toBe(false);
	});

	it("renders exactly one summary line (no raw detail) when not verbose", () => {
		const c = new GeneratorWarningCollector();
		c.beginSource("payment-summary.tsx");
		for (let i = 0; i < 4; i++) c.warn("spread-object", "spread in object — skipping");
		const lines = c.render({});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("4 component examples couldn't be parsed");
		expect(lines.some((l) => l.includes("spread in object"))).toBe(false);
	});

	it("ignores warnings emitted with no active source (defensive)", () => {
		const c = new GeneratorWarningCollector();
		c.warn("spread-object", "spread in object — skipping");
		expect(c.isEmpty).toBe(true);
	});
});
