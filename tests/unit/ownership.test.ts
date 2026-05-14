import { describe, it, expect } from "vitest";
import { categoryOf } from "../../src/lib/ownership";
import type { Manifest } from "../../src/lib/manifest";

const m: Manifest = { files: [
  { path: ".claude/settings.json", category: "managed" },
  { path: "contracts.md", category: "seeded" },
  { path: "CLAUDE.md", category: "hybrid", format: "markdown" },
]};

describe("ownership", () => {
  it("returns the declared category", () => {
    expect(categoryOf(m, ".claude/settings.json")).toBe("managed");
    expect(categoryOf(m, "CLAUDE.md")).toBe("hybrid");
  });
  it("returns null for unknown paths", () => {
    expect(categoryOf(m, "some/random/file")).toBeNull();
  });
});
