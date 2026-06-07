/**
 * PRD #325 sub-issue #330 — the renderer module is the one barrel every
 * later slice imports from. `renderDecision` from PRD sub-issue #326 is
 * wired through this same module so the human-facing surface has a single
 * import surface: `from "src/lib/render"`.
 */
import { describe, it, expect } from "vitest";
import * as render from "../../../src/lib/render/index.js";

describe("render barrel", () => {
  it("re-exports renderDecision from the Decision spine", () => {
    expect(typeof render.renderDecision).toBe("function");
    const lines = render.renderDecision({
      id: "x",
      kind: "ambiguity",
      question: "?",
      options: [{ label: "yes", description: "y" }],
    });
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("exposes the pure renderers and the TTY helper", () => {
    expect(typeof render.renderDashboard).toBe("function");
    expect(typeof render.renderFindings).toBe("function");
    expect(typeof render.renderCommitmentGateDiff).toBe("function");
    expect(typeof render.colorizeDiffLines).toBe("function");
    expect(typeof render.identityColor).toBe("object");
    expect(typeof render.isTTY).toBe("function");
  });
});
