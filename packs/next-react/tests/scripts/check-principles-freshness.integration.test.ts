import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/check-principles-freshness.ts");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "int-principles-"));
}

function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("check-principles-freshness.ts [integration]", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("exit 0 when contracts.md has recent Last reviewed date", async () => {
    const dsDir = join(dir, "design-system");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "contracts.md"),
      `# Contracts\n\nLast reviewed: ${offsetDate(-10)}\n`
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });

  it("exit 2, stderr PRIN-001 in contract format when >90 days", async () => {
    const dsDir = join(dir, "design-system");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "contracts.md"),
      `# Contracts\n\nLast reviewed: ${offsetDate(-100)}\n`
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^[^:]+:\d+: PRIN-001: /m);
  });

  it("exit 1 with PRIN-000 when Last reviewed line is missing", async () => {
    const dsDir = join(dir, "design-system");
    await mkdir(dsDir, { recursive: true });
    await writeFile(join(dsDir, "contracts.md"), `# Contracts\n\nSome content.\n`);

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/PRIN-000/);
  });

  it("exit 1 when contracts.md does not exist", () => {
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/PRIN-000/);
  });
});
