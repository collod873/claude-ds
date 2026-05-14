import { describe, it, expect } from "vitest";
import { mergeMarkers, MarkerError } from "../../src/lib/markers";

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
