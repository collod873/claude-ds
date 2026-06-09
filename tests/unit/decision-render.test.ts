/**
 * PRD #325 sub-issue #326 — `renderDecision` is a pure function: it returns
 * an array of strings, performs no terminal I/O, and never mutates global
 * state. The TTY layer prints the lines; tests assert content without a pty.
 */
import { describe, expect, it } from "vitest";
import { type Decision, renderDecision } from "../../src/lib/decision/index.js";

describe("renderDecision (pure)", () => {
	it("returns a non-empty line array containing the question and every option", () => {
		const d: Decision = {
			id: "raw-color:design-system/atoms/button.tsx",
			kind: "ambiguity",
			question: "Which token best matches color #336699?",
			options: [
				{ label: "blue-500", description: "the closest token in the palette" },
				{ label: "primary-600", description: "semantic match by usage" },
			],
		};
		const lines = renderDecision(d);
		expect(Array.isArray(lines)).toBe(true);
		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		expect(joined).toContain("Which token best matches color #336699?");
		expect(joined).toContain("blue-500");
		expect(joined).toContain("the closest token in the palette");
		expect(joined).toContain("primary-600");
		expect(joined).toContain("semantic match by usage");
	});

	it("renders a one-option commitment-gate without crashing", () => {
		const d: Decision = {
			id: "audit-fix-apply",
			kind: "commitment-gate",
			question: "Apply 3 changes?",
			options: [{ label: "Apply", description: "write the batch" }],
		};
		const lines = renderDecision(d);
		expect(lines.some((l) => l.includes("Apply 3 changes?"))).toBe(true);
		expect(lines.some((l) => l.includes("Apply"))).toBe(true);
	});

	it("is pure — calling twice returns equal arrays", () => {
		const d: Decision = {
			id: "x",
			kind: "ambiguity",
			question: "?",
			options: [
				{ label: "a", description: "alpha" },
				{ label: "b", description: "beta" },
			],
		};
		expect(renderDecision(d)).toEqual(renderDecision(d));
	});
});
