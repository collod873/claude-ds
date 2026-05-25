import { describe, it, expect } from "vitest";
import { parseManifest, isManifestOrKeepfile, ManifestError } from "../../src/lib/manifest";

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

describe("isManifestOrKeepfile", () => {
  it("returns true for exact manifest match", () => {
    const paths = new Set(["design-system/icons/.keep"]);
    expect(isManifestOrKeepfile("design-system/icons/.keep", paths)).toBe(true);
  });

  it("returns true for .gitkeep when manifest has .keep", () => {
    const paths = new Set(["design-system/icons/.keep"]);
    expect(isManifestOrKeepfile("design-system/icons/.gitkeep", paths)).toBe(true);
  });

  it("returns true for .keep when manifest has .gitkeep", () => {
    const paths = new Set(["design-system/icons/.gitkeep"]);
    expect(isManifestOrKeepfile("design-system/icons/.keep", paths)).toBe(true);
  });

  it("returns false for non-keepfile not in manifest", () => {
    const paths = new Set(["design-system/icons/.keep"]);
    expect(isManifestOrKeepfile("design-system/icons/logo.svg", paths)).toBe(false);
  });

  it("returns false for .gitkeep when manifest has neither variant", () => {
    const paths = new Set(["design-system/contracts.md"]);
    expect(isManifestOrKeepfile("design-system/icons/.gitkeep", paths)).toBe(false);
  });
});
