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
      ".claude/hooks/lib/log-failure.sh",
      "design-system/contracts.md",
      "design-system/tokens.json",
      "design-system/README.md",
      "design-system/CLAUDE.md",
      "commitlint.config.js",
      "CLAUDE.md",
      "package.json",
      "design-system/exceptions.json",
      "design-system/failure-log.md",
    ]) expect(paths).toContain(p);
    expect(m.files.find((f) => f.path === "CLAUDE.md")!.category).toBe("hybrid");
    expect(m.files.find((f) => f.path === ".claude/settings.json")!.category).toBe("hybrid");
    expect(m.files.find((f) => f.path === ".claude/settings.json")!.format).toBe("json");
    expect(m.files.find((f) => f.path === "design-system/contracts.md")!.category).toBe("seeded");
  });

  // #293: DOM test runtime — vitest config + setup land as seeded so a fresh adopt
  // can collect+run `design-system/**/*.test.tsx` stubs without consumer wiring.
  it("seeds vitest.config.ts and vitest.setup.ts for the DOM test runtime", async () => {
    const raw = await readFile("packs/next-react/manifest.json", "utf8");
    const m = parseManifest(raw);
    const config = m.files.find((f) => f.path === "vitest.config.ts");
    const setup = m.files.find((f) => f.path === "vitest.setup.ts");
    expect(config?.category).toBe("seeded");
    expect(setup?.category).toBe("seeded");
  });
});
