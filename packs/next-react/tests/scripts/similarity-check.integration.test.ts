import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/similarity-check.ts");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "int-similarity-"));
}

describe("similarity-check.ts [integration]", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("exit 0 when no near-duplicates exist", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(join(atomsDir, "Button.tsx"), "");
    await writeFile(join(atomsDir, "Accordion.tsx"), "");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });

  it("exit 2, stderr SIM-001 in contract format when near-duplicate detected", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    // distance 1
    await writeFile(join(atomsDir, "Button.tsx"), "");
    await writeFile(join(atomsDir, "Buton.tsx"), "");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^[^:]+:\d+: SIM-001: /m);
  });
});
