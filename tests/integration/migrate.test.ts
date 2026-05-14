import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

async function adopted(dir: string) {
  await mkdir(join(dir, "design-system/atoms"), { recursive: true });
  await mkdir(join(dir, "design-system/composites"), { recursive: true });
  await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version:"v0.0.0", pack:"next-react", mode:"warn" }));
  await writeFile(join(dir, "exceptions.json"), "[]");
}

describe("migrate", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); await adopted(dir); });
  afterEach(async () => { await cleanup(dir); });

  it("moves a no-import component to atoms/", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    await writeFile(join(dir, "src/components/button.tsx"), `export const Button = () => null;`);
    const r = await runCli(["migrate", "src/components/button.tsx", "--reason", "ok", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    await stat(join(dir, "design-system/atoms/button.tsx"));
  });

  it("rejects a tier-violation source", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/bad.tsx"), `import { Card } from "@/design-system/composites/card";\nexport const Bad = () => null;`);
    const r = await runCli(["migrate", "src/bad.tsx", "--reason", "x", "--yes"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/tier violation/i);
  });

  it("refuses on collision without --rename", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    await writeFile(join(dir, "src/components/button.tsx"), `export const Button = () => null;`);
    await writeFile(join(dir, "design-system/atoms/button.tsx"), `export const Button = () => null;`);
    const r = await runCli(["migrate", "src/components/button.tsx", "--reason","x","--yes"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/collision|exists/i);
  });
});
