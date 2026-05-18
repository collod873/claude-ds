import { describe, it, expect } from "vitest";
import { parseManifest, ManifestError } from "../../src/lib/manifest";

describe("parseManifest — deprecated_paths", () => {
  it("accepts an empty deprecated_paths array", () => {
    const m = parseManifest(JSON.stringify({
      files: [{ path: "a.md", category: "seeded" }],
      deprecated_paths: [],
    }));
    expect(m.deprecated_paths).toHaveLength(0);
  });

  it("defaults deprecated_paths to [] when field is absent", () => {
    const m = parseManifest(JSON.stringify({
      files: [{ path: "a.md", category: "seeded" }],
    }));
    expect(m.deprecated_paths).toEqual([]);
  });

  it("parses well-formed deprecated_paths entries", () => {
    const m = parseManifest(JSON.stringify({
      files: [],
      deprecated_paths: [
        { path: "contracts.md", since_version: "v0.3.0", reason: "moved to design-system/" },
        { path: "exceptions.json", since_version: "v0.3.0", reason: "moved to design-system/" },
      ],
    }));
    expect(m.deprecated_paths).toHaveLength(2);
    expect(m.deprecated_paths[0]).toEqual({
      path: "contracts.md",
      since_version: "v0.3.0",
      reason: "moved to design-system/",
    });
  });

  it("throws ManifestError when deprecated_paths entry is missing path", () => {
    expect(() => parseManifest(JSON.stringify({
      files: [],
      deprecated_paths: [{ since_version: "v0.3.0", reason: "oops" }],
    }))).toThrow(ManifestError);
  });

  it("throws ManifestError when deprecated_paths entry is missing since_version", () => {
    expect(() => parseManifest(JSON.stringify({
      files: [],
      deprecated_paths: [{ path: "foo.md", reason: "oops" }],
    }))).toThrow(ManifestError);
  });

  it("throws ManifestError when deprecated_paths entry is missing reason", () => {
    expect(() => parseManifest(JSON.stringify({
      files: [],
      deprecated_paths: [{ path: "foo.md", since_version: "v0.1.0" }],
    }))).toThrow(ManifestError);
  });

  it("next-react pack manifest parses without error and includes deprecated_paths", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "packs", "next-react");
    const raw = await readFile(resolve(root, "manifest.json"), "utf8");
    const m = parseManifest(raw);
    expect(m.deprecated_paths).toHaveLength(10);
    const paths = m.deprecated_paths.map(d => d.path);
    expect(paths).toContain("contracts.md");
    expect(paths).toContain("exceptions.json");
    expect(paths).toContain("failure-log.md");
    expect(paths).toContain(".claude/skills/badge-system/SKILL.md");
    expect(paths).toContain(".claude/skills/typography/SKILL.md");
    expect(paths).toContain(".claude/skills/design-review/SKILL.md");
    expect(paths).toContain(".claude/skills/icons/SKILL.md");
    expect(paths).toContain("app/_design");
    expect(paths).toContain(".claude/hooks/token-only.sh");
    expect(paths).toContain(".claude/hooks/token-only.sh.verify-fixture.json");
  });
});
