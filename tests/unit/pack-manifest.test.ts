import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parseManifest } from "../../src/lib/manifest";

describe("next-react manifest", () => {
  it("loads and lists every shipped path", async () => {
    const raw = await readFile("packs/next-react/manifest.json", "utf8");
    const m = parseManifest(raw);
    const paths = m.files.map((f) => f.path);
    for (const p of [
      ".claude/settings.json",
      ".claude/hooks/atom-imports.sh",
      "scripts/log-failure.sh",
      "contracts.md",
      "tokens.json",
      "design-system/README.md",
      "commitlint.config.js",
      "CLAUDE.md",
      "package.json",
      "exceptions.json",
      "failure-log.md",
    ]) expect(paths).toContain(p);
    expect(m.files.find((f) => f.path === "CLAUDE.md")!.category).toBe("hybrid");
    expect(m.files.find((f) => f.path === ".claude/settings.json")!.category).toBe("hybrid");
    expect(m.files.find((f) => f.path === ".claude/settings.json")!.format).toBe("json");
    expect(m.files.find((f) => f.path === "contracts.md")!.category).toBe("seeded");
  });
});
