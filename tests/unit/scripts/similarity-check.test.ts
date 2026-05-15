import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/similarity-check.ts");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "similarity-check-"));
}

describe("similarity-check.ts", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("happy path: exits 0 when no near-duplicate names exist", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(join(atomsDir, "Button.tsx"), "");
    await writeFile(join(atomsDir, "Accordion.tsx"), "");
    await writeFile(join(atomsDir, "Tooltip.tsx"), "");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });

  it("refusal path: exits 2 with SIM-001 when two names are within Levenshtein 3", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    // "Buton" vs "Button" → distance 1
    await writeFile(join(atomsDir, "Button.tsx"), "");
    await writeFile(join(atomsDir, "Buton.tsx"), "");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/SIM-001/);
    expect(r.stderr).toMatch(/Button.*Buton|Buton.*Button/);
  });

  it("self-error: exits 1 when design-system/ is missing", () => {
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SIM-000/);
  });
});
