import { describe, expect, it } from "vitest";
import { formatFindings, formatScorecard } from "../../../src/lib/reports/findings-format";

describe("formatFindings", () => {
	it("groups findings by rule ID and emits a single header per rule", () => {
		const lines = formatFindings([
			{
				ruleId: "DRIFT-MISPLACED",
				file: "design-system/composites/a.tsx",
				message: "should be atom",
			},
			{
				ruleId: "DRIFT-MISPLACED",
				file: "design-system/composites/b.tsx",
				message: "should be atom",
			},
			{
				ruleId: "DRIFT-PATTERN-NO-SLOTS",
				file: "design-system/patterns/x.tsx",
				message: "no slots",
			},
		]);
		const headerLines = lines.filter((l) => /^[A-Z]+\s+\[/.test(l));
		expect(headerLines).toHaveLength(2);
		expect(headerLines.some((l) => l.includes("[DRIFT-MISPLACED]"))).toBe(true);
		expect(headerLines.some((l) => l.includes("[DRIFT-PATTERN-NO-SLOTS]"))).toBe(true);
	});

	it("uses ERROR prefix for error-severity drift rules", () => {
		const lines = formatFindings([
			{ ruleId: "DRIFT-MISPLACED", file: "design-system/composites/a.tsx", message: "x" },
		]);
		expect(lines[0]).toMatch(/^ERROR\s+\[DRIFT-MISPLACED\]/);
	});

	it("uses ERROR prefix for integrity findings", () => {
		const lines = formatFindings([
			{
				ruleId: "INTEGRITY-UNPARSEABLE",
				file: "design-system/atoms/broken.tsx",
				message: "syntax",
			},
		]);
		expect(lines[0]).toMatch(/^ERROR\s+\[INTEGRITY-UNPARSEABLE\]/);
	});

	it("uses singular noun for a single finding and plural for many", () => {
		const single = formatFindings([
			{ ruleId: "DRIFT-MISPLACED", file: "design-system/composites/a.tsx", message: "x" },
		]);
		expect(single[0]).toMatch(/\(1 finding\)/);

		const many = formatFindings([
			{ ruleId: "DRIFT-MISPLACED", file: "design-system/composites/a.tsx", message: "x" },
			{ ruleId: "DRIFT-MISPLACED", file: "design-system/composites/b.tsx", message: "y" },
		]);
		expect(many[0]).toMatch(/\(2 findings\)/);
	});

	it("indents each finding's file/message under its rule header", () => {
		const lines = formatFindings([
			{
				ruleId: "DRIFT-MISPLACED",
				file: "design-system/composites/a.tsx",
				message: "should be atom",
			},
		]);
		expect(lines).toContain("  design-system/composites/a.tsx: should be atom");
	});

	it("returns no lines when there are no findings", () => {
		expect(formatFindings([])).toEqual([]);
	});

	describe("advisory grouping (#586)", () => {
		const advisory = [
			{ ruleId: "BYPASS-CARD", file: "app/a.tsx:18", message: "hand-rolled card" },
			{ ruleId: "BYPASS-BADGE", file: "app/b.tsx:3", message: "hand-rolled badge" },
			{ ruleId: "BYPASS-BADGE", file: "app/c.tsx:5", message: "hand-rolled badge" },
		];
		const opts = {
			severityFor: () => "info" as const,
			noteFor: (ruleId: string) =>
				`review: import the ${ruleId === "BYPASS-CARD" ? "Card" : "Badge/Tag"} atom, or dismiss via design-system/exceptions.json if a legitimate non-atom use`,
		};

		it("resolves a severity prefix for ids outside the drift/integrity tables", () => {
			const lines = formatFindings(advisory, opts);
			const headers = lines.filter((l) => /^[A-Z]+\s+\[/.test(l));
			expect(headers.every((l) => l.startsWith("INFO"))).toBe(true);
		});

		it("renders the mechanism sentence once per rule, not once per finding", () => {
			const lines = formatFindings(advisory, opts);
			const badgeMechanism = lines.filter((l) => l.includes("import the Badge/Tag atom"));
			// Two BYPASS-BADGE findings, but the dismiss sentence appears once.
			expect(badgeMechanism).toHaveLength(1);
			expect(badgeMechanism[0]).toContain("[BYPASS-BADGE] (2 findings)");
		});

		it("renders each finding's path once, under its rule header", () => {
			const lines = formatFindings(advisory, opts);
			expect(lines).toContain("  app/b.tsx:3: hand-rolled badge");
			expect(lines).toContain("  app/c.tsx:5: hand-rolled badge");
			expect(lines.filter((l) => l.includes("app/b.tsx:3"))).toHaveLength(1);
		});

		it("appends the note to the header line when noteFor is given", () => {
			const lines = formatFindings(advisory, opts);
			const cardHeader = lines.find((l) => l.includes("[BYPASS-CARD]"));
			expect(cardHeader).toMatch(/\[BYPASS-CARD\] \(1 finding\) — review: import the Card atom/);
		});
	});
});

describe("formatScorecard", () => {
	it("includes scaffold count with a ✓ when fully present", () => {
		const line = formatScorecard({
			scaffoldPresent: 5,
			scaffoldTotal: 5,
			reconciledCount: 0,
			fixedCount: 0,
			warningCount: 0,
			errorCount: 0,
		});
		expect(line).toMatch(/Managed files: 5\/5 ✓/);
	});

	it("omits the ✓ when scaffold is not fully present", () => {
		const line = formatScorecard({
			scaffoldPresent: 3,
			scaffoldTotal: 5,
			reconciledCount: 0,
			fixedCount: 0,
			warningCount: 0,
			errorCount: 0,
		});
		expect(line).toContain("Managed files: 3/5");
		expect(line).not.toContain("✓");
	});

	it("includes reconciled, fixed, warning, and error counts when > 0", () => {
		const line = formatScorecard({
			scaffoldPresent: 5,
			scaffoldTotal: 5,
			reconciledCount: 2,
			fixedCount: 3,
			warningCount: 1,
			errorCount: 4,
		});
		expect(line).toContain("Reconciled: 2");
		expect(line).toContain("Fixed: 3");
		expect(line).toContain("Warnings: 1");
		expect(line).toContain("Errors: 4");
	});

	it("omits zero-count segments", () => {
		const line = formatScorecard({
			scaffoldPresent: 5,
			scaffoldTotal: 5,
			reconciledCount: 0,
			fixedCount: 0,
			warningCount: 0,
			errorCount: 0,
		});
		expect(line).not.toContain("Reconciled:");
		expect(line).not.toContain("Fixed:");
		expect(line).not.toContain("Warnings:");
		expect(line).not.toContain("Errors:");
	});

	it("joins segments with ' | '", () => {
		const line = formatScorecard({
			scaffoldPresent: 5,
			scaffoldTotal: 5,
			reconciledCount: 1,
			fixedCount: 0,
			warningCount: 0,
			errorCount: 0,
		});
		expect(line).toBe("Managed files: 5/5 ✓ | Reconciled: 1");
	});
});
