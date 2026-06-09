import { describe, expect, it } from "vitest";
import { extractMarkerInner, MarkerError, mergeMarkers } from "../../src/lib/markers";

const OPEN = "<!-- >>> claude-ds managed >>> -->";
const CLOSE = "<!-- <<< claude-ds managed <<< -->";

describe("mergeMarkers (markdown)", () => {
	it("replaces only inside the marker block", () => {
		const before = `# Header\n${OPEN}\nold\n${CLOSE}\nbelow`;
		const out = mergeMarkers(before, "new", "markdown");
		expect(out).toBe(`# Header\n${OPEN}\nnew\n${CLOSE}\nbelow`);
	});
	it("rejects missing closing marker", () => {
		expect(() => mergeMarkers(`${OPEN}\nx`, "y", "markdown")).toThrow(MarkerError);
	});
	it("rejects multiple marker pairs", () => {
		const txt = `${OPEN}\na\n${CLOSE}\n${OPEN}\nb\n${CLOSE}`;
		expect(() => mergeMarkers(txt, "z", "markdown")).toThrow(MarkerError);
	});
});

const JS_OPEN = "// >>> claude-ds managed >>>";
const JS_CLOSE = "// <<< claude-ds managed <<<";

describe("mergeMarkers / extractMarkerInner (javascript)", () => {
	it("replaces only inside the JS marker block", () => {
		const before = `const x = 1;\n${JS_OPEN}\nconst old = true;\n${JS_CLOSE}\nmodule.exports = {};`;
		const out = mergeMarkers(before, "const updated = true;", "javascript");
		expect(out).toBe(
			`const x = 1;\n${JS_OPEN}\nconst updated = true;\n${JS_CLOSE}\nmodule.exports = {};`,
		);
	});

	it("extracts inner content from JS marker block", () => {
		const src = `${JS_OPEN}\nconst dsExtend = {};\n${JS_CLOSE}`;
		expect(extractMarkerInner(src, "javascript")).toBe("const dsExtend = {};");
	});

	it("rejects missing closing marker", () => {
		expect(() => mergeMarkers(`${JS_OPEN}\nx`, "y", "javascript")).toThrow(MarkerError);
	});

	it("rejects missing opening marker", () => {
		expect(() => extractMarkerInner(`const x = 1;\n${JS_CLOSE}`, "javascript")).toThrow(
			MarkerError,
		);
	});
});
