import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../../tests/helpers/runcli";

/**
 * Minimal frontmatter parser — extracts top-level scalars and sequences from
 * the YAML block between the first pair of `---` fences.
 */
function parseFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error("No frontmatter found");
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of match[1].split("\n")) {
    const listItem = line.match(/^\s+-\s+"?([^"]+?)"?\s*$/);
    if (listItem && currentKey && currentList) {
      currentList.push(listItem[1].trim());
      continue;
    }
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)?$/);
    if (kv) {
      if (currentKey && currentList) result[currentKey] = currentList;
      currentKey = kv[1];
      const val = kv[2]?.trim();
      if (!val) {
        currentList = [];
      } else {
        currentList = null;
        result[currentKey] = val;
        currentKey = null;
      }
    }
  }
  if (currentKey && currentList) result[currentKey] = currentList;
  return result;
}

// Every test inspects the same read-only scaffold, so init runs once for the
// whole file (in-process via the shared runCli helper — no spawn).
describe("next-react skills (fixture)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-ds-skills-"));
    const r = await runCli(["init", "--pack", "next-react", "--yes"], { cwd: dir });
    if (r.code !== 0) throw new Error(`init failed (${r.code}): ${r.stderr}`);
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("all skill dirs land after adopt (init)", async () => {
    await stat(join(dir, ".claude/skills/aesthetic-principles/SKILL.md"));
    await stat(join(dir, ".claude/skills/design-system/SKILL.md"));
    await stat(join(dir, ".claude/skills/design-system/contracts.md"));
    await stat(join(dir, ".claude/skills/component/SKILL.md"));
    await stat(join(dir, ".claude/skills/pattern/SKILL.md"));
  });

  it("scaffold-component skill is not present after init", async () => {
    await expect(stat(join(dir, ".claude/skills/scaffold-component/SKILL.md"))).rejects.toThrow();
  });

  it("aesthetic-principles SKILL.md frontmatter parses and triggers on **/*.tsx", async () => {
    const raw = await readFile(join(dir, ".claude/skills/aesthetic-principles/SKILL.md"), "utf8");
    const fm = parseFrontmatter(raw);
    expect(fm).toHaveProperty("triggers");
    const triggers = fm["triggers"] as string[];
    expect(Array.isArray(triggers)).toBe(true);
    expect(triggers).toContain("**/*.tsx");
  });

  it("design-system SKILL.md frontmatter parses and triggers on design-system/**", async () => {
    const raw = await readFile(join(dir, ".claude/skills/design-system/SKILL.md"), "utf8");
    const fm = parseFrontmatter(raw);
    expect(fm).toHaveProperty("triggers");
    const triggers = fm["triggers"] as string[];
    expect(Array.isArray(triggers)).toBe(true);
    expect(triggers).toContain("design-system/**");
  });

  it("aesthetic-principles tier is A (scaffold Tier A)", async () => {
    const raw = await readFile(join(dir, ".claude/skills/aesthetic-principles/SKILL.md"), "utf8");
    const fm = parseFrontmatter(raw);
    expect(fm["tier"]).toBe("A");
  });

  it("design-system tier is B (scaffold Tier B)", async () => {
    const raw = await readFile(join(dir, ".claude/skills/design-system/SKILL.md"), "utf8");
    const fm = parseFrontmatter(raw);
    expect(fm["tier"]).toBe("B");
  });

  it("component SKILL.md triggers include intent phrases and glob paths", async () => {
    const raw = await readFile(join(dir, ".claude/skills/component/SKILL.md"), "utf8");
    const fm = parseFrontmatter(raw);
    expect(fm["tier"]).toBe("B");
    const triggers = fm["triggers"] as string[];
    expect(triggers).toContain("new atom");
    expect(triggers).toContain("new composite");
    expect(triggers).toContain("new component");
    expect(triggers).toContain("design-system/atoms/**");
    expect(triggers).toContain("design-system/composites/**");
  });

  it("pattern SKILL.md triggers include intent phrases and glob paths", async () => {
    const raw = await readFile(join(dir, ".claude/skills/pattern/SKILL.md"), "utf8");
    const fm = parseFrontmatter(raw);
    expect(fm["tier"]).toBe("B");
    const triggers = fm["triggers"] as string[];
    expect(triggers).toContain("new pattern");
    expect(triggers).toContain("new layout");
    expect(triggers).toContain("design-system/patterns/**");
  });

  it("neither new skill inlines the Meta type", async () => {
    const component = await readFile(join(dir, ".claude/skills/component/SKILL.md"), "utf8");
    const pattern = await readFile(join(dir, ".claude/skills/pattern/SKILL.md"), "utf8");
    for (const raw of [component, pattern]) {
      expect(raw).toContain("types/meta.ts");
      expect(raw).not.toMatch(/export\s+type\s+Meta\b/);
      expect(raw).not.toMatch(/kind:\s*"atom"\s*\|\s*"composite"/);
    }
  });

  it("design-system SKILL.md mentions references tier", async () => {
    const raw = await readFile(join(dir, ".claude/skills/design-system/SKILL.md"), "utf8");
    expect(raw).toContain("references/");
    expect(raw).toMatch(/kind:\s*"reference"/);
  });
});
