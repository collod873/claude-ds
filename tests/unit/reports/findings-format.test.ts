import { describe, expect, it } from "vitest";
import {
	formatFindings,
	formatScorecard,
	formatVerifyErrors,
} from "../../../src/lib/reports/findings-format";

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

describe("formatVerifyErrors (#587)", () => {
	const err = (file: string, code: string, line: number, message: string) => ({
		file,
		line,
		col: 5,
		code,
		message,
		raw: "",
	});

	it("returns no lines when there are no errors", () => {
		expect(formatVerifyErrors([])).toEqual([]);
	});

	it("renders a lone diagnostic verbatim with its location", () => {
		const lines = formatVerifyErrors([
			err("design-system/atoms/button.tsx", "TS2300", 2, "Duplicate identifier 'meta'."),
		]);
		expect(lines).toEqual([
			"  design-system/atoms/button.tsx:2:5  TS2300: Duplicate identifier 'meta'.",
		]);
	});

	it("collapses repeats of the same file × code into one counted exemplar line", () => {
		const lines = formatVerifyErrors([
			err("design-system/a.tsx", "TS2322", 10, "Type 'X' is not assignable."),
			err("design-system/a.tsx", "TS2322", 20, "Type 'Y' is not assignable."),
			err("design-system/a.tsx", "TS2322", 30, "Type 'Z' is not assignable."),
			err("design-system/a.tsx", "TS2322", 40, "Type 'W' is not assignable."),
		]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("4× TS2322 in design-system/a.tsx");
		expect(lines[0]).toContain("e.g.");
		// One exemplar (the first occurrence) carries the location + message.
		expect(lines[0]).toContain("design-system/a.tsx:10:5");
		expect(lines[0]).toContain("Type 'X' is not assignable.");
	});

	it("does not collapse across different codes in the same file", () => {
		const lines = formatVerifyErrors([
			err("design-system/a.tsx", "TS2322", 10, "x"),
			err("design-system/a.tsx", "TS2304", 11, "y"),
		]);
		expect(lines).toHaveLength(2);
	});

	it("does not collapse the same code across different files", () => {
		const lines = formatVerifyErrors([
			err("design-system/a.tsx", "TS2322", 10, "x"),
			err("design-system/b.tsx", "TS2322", 11, "y"),
		]);
		expect(lines).toHaveLength(2);
	});

	it("caps the number of groups and notes the remainder", () => {
		const errors = Array.from({ length: 25 }, (_, i) =>
			err(`design-system/f${i}.tsx`, "TS2322", i + 1, "x"),
		);
		const lines = formatVerifyErrors(errors, { maxGroups: 20 });
		expect(lines).toHaveLength(21);
		expect(lines[20]).toBe("  …and 5 more");
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
