import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/check-principles-freshness.ts");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "principles-freshness-"));
}

/** Returns an ISO date string offset by `days` from today. */
function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("check-principles-freshness.ts", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("happy path: exits 0 when Last reviewed is within 90 days", async () => {
    const dsDir = join(dir, "design-system");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "contracts.md"),
      `# Design-system contracts\n\nSome content here.\n\nLast reviewed: ${offsetDate(-5)}\n`
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });

  it("refusal path: exits 2 with PRIN-001 when Last reviewed is >90 days ago", async () => {
    const dsDir = join(dir, "design-system");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "contracts.md"),
      `# Design-system contracts\n\nSome content here.\n\nLast reviewed: ${offsetDate(-91)}\n`
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/PRIN-001/);
  });

  it("self-error: exits 1 with PRIN-000 when Last reviewed line is missing", async () => {
    const dsDir = join(dir, "design-system");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "contracts.md"),
      `# Design-system contracts\n\nSome content here.\n`
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/PRIN-000/);
  });

  it("self-error: exits 1 when contracts.md does not exist", () => {
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/PRIN-000/);
  });
});
