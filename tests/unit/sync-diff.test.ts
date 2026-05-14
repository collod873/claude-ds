import { describe, it, expect } from "vitest";
import { diffFile, FileVerdict } from "../../src/lib/sync-diff";

describe("sync-diff (managed)", () => {
  it("rewrite when upstream changes and on-disk matches previous", () => {
    const v = diffFile({ category: "managed" }, { prev: "A", upstream: "B", current: "A" });
    expect(v).toEqual<FileVerdict>({ action: "rewrite", reason: "upstream changed" });
  });
  it("abort when on-disk diverges from previous (hand-edited managed file)", () => {
    const v = diffFile({ category: "managed" }, { prev: "A", upstream: "B", current: "A-modified" });
    expect(v.action).toBe("abort");
  });
  it("skip when nothing changed", () => {
    const v = diffFile({ category: "managed" }, { prev: "A", upstream: "A", current: "A" });
    expect(v.action).toBe("skip");
  });
});

describe("sync-diff (hybrid)", () => {
  it("rewrites only the marker region", () => {
    const v = diffFile({ category: "hybrid", format: "markdown" }, {
      prev: "outer\n<!-- >>> claude-ds managed >>> -->\nA\n<!-- <<< claude-ds managed <<< -->\n",
      upstream: "outer\n<!-- >>> claude-ds managed >>> -->\nB\n<!-- <<< claude-ds managed <<< -->\n",
      current: "USER OUTER\n<!-- >>> claude-ds managed >>> -->\nA\n<!-- <<< claude-ds managed <<< -->\nMORE USER\n",
    });
    expect(v.action).toBe("rewrite-region");
    if (v.action === "rewrite-region") expect(v.newContent).toContain("USER OUTER");
  });
});
