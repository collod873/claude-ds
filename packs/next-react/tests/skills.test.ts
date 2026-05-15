import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));

async function runCli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn("npx", ["tsx", CLI_PATH, ...args], { cwd });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
  });
}

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

describe("next-react skills (fixture)", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "claude-ds-skills-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("both skill dirs land after adopt (init)", async () => {
    const r = await runCli(["init", "--pack", "next-react", "--yes"], dir);
    expect(r.code).toBe(0);
    await stat(join(dir, ".claude/skills/aesthetic-principles/SKILL.md"));
    await stat(join(dir, ".claude/skills/design-system/SKILL.md"));
    await stat(join(dir, ".claude/skills/design-system/contracts.md"));
  });

  it("aesthetic-principles SKILL.md frontmatter parses and triggers on **/*.tsx", async () => {
    const r = await runCli(["init", "--pack", "next-react", "--yes"], dir);
    expect(r.code).toBe(0);
    const raw = await readFile(join(dir, ".claude/skills/aesthetic-principles/SKILL.md"), "utf8");
    const fm = parseFrontmatter(raw);
    expect(fm).toHaveProperty("triggers");
    const triggers = fm["triggers"] as string[];
    expect(Array.isArray(triggers)).toBe(true);
    expect(triggers).toContain("**/*.tsx");
  });

  it("design-system SKILL.md frontmatter parses and triggers on design-system/**", async () => {
    const r = await runCli(["init", "--pack", "next-react", "--yes"], dir);
    expect(r.code).toBe(0);
    const raw = await readFile(join(dir, ".claude/skills/design-system/SKILL.md"), "utf8");
    const fm = parseFrontmatter(raw);
    expect(fm).toHaveProperty("triggers");
    const triggers = fm["triggers"] as string[];
    expect(Array.isArray(triggers)).toBe(true);
    expect(triggers).toContain("design-system/**");
  });

  it("aesthetic-principles tier is A (scaffold Tier A)", async () => {
    const r = await runCli(["init", "--pack", "next-react", "--yes"], dir);
    expect(r.code).toBe(0);
    const raw = await readFile(join(dir, ".claude/skills/aesthetic-principles/SKILL.md"), "utf8");
    const fm = parseFrontmatter(raw);
    expect(fm["tier"]).toBe("A");
  });

  it("design-system tier is B (scaffold Tier B)", async () => {
    const r = await runCli(["init", "--pack", "next-react", "--yes"], dir);
    expect(r.code).toBe(0);
    const raw = await readFile(join(dir, ".claude/skills/design-system/SKILL.md"), "utf8");
    const fm = parseFrontmatter(raw);
    expect(fm["tier"]).toBe("B");
  });
});
