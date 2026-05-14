import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

describe("sync", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("refuses without .claude-ds.json", async () => {
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir });
    expect(r.code).not.toBe(0);
  });

  it("rewrites a managed file when the local pack fixture has changed", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version:"v0.0.0", pack:"next-react", mode:"warn" }));
    await writeFile(join(dir, ".claude/settings.json"), `{"old":true}`);
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const cur = await readFile(join(dir, ".claude/settings.json"), "utf8");
    expect(cur).not.toBe(`{"old":true}`);
  });
});
