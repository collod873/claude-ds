import { describe, it, expect } from "vitest";
import { parseManifest, ManifestError } from "../../src/lib/manifest";

describe("parseManifest", () => {
  it("accepts managed/seeded/generated/hybrid", () => {
    const m = parseManifest(JSON.stringify({ files: [
      { path: ".claude/settings.json", category: "managed" },
      { path: "contracts.md", category: "seeded" },
      { path: "manifest.json", category: "generated" },
      { path: "CLAUDE.md", category: "hybrid", format: "markdown" },
    ]}));
    expect(m.files).toHaveLength(4);
  });
  it("rejects unknown category", () => {
    expect(() => parseManifest(JSON.stringify({ files: [{ path: "x", category: "weird" }] })))
      .toThrow(ManifestError);
  });
  it("requires format on hybrid entries", () => {
    expect(() => parseManifest(JSON.stringify({ files: [{ path: "x", category: "hybrid" }] })))
      .toThrow(ManifestError);
  });
});
