import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/check-tier-imports.ts");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "check-tier-"));
}

describe("check-tier-imports.ts", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("happy path: exits 0 for clean atom with no forbidden imports", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(join(atomsDir, "Button.tsx"), `
import React from "react";
import { tokens } from "design-system/tokens";
export const Button = () => null;
`);

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });

  it("refusal path: exits 2 with TIER-001 when atom imports from composites/", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(join(atomsDir, "BadAtom.tsx"), `
import { Card } from "../design-system/composites/Card";
export const BadAtom = () => null;
`);

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/TIER-001/);
  });

  it("refusal path: exits 2 with TIER-002 when composite imports from app/", async () => {
    const compositesDir = join(dir, "design-system", "composites");
    await mkdir(compositesDir, { recursive: true });
    await writeFile(join(compositesDir, "BadComposite.tsx"), `
import { MyPage } from "../../app/my-page";
export const BadComposite = () => null;
`);

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/TIER-002/);
  });

  it("refusal path: exits 2 with TIER-003 when DS file imports from src/", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(join(atomsDir, "SrcAtom.tsx"), `
import { util } from "src/utils";
export const SrcAtom = () => null;
`);

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/TIER-003/);
  });

  it("self-error: exits 1 when design-system/ is missing", () => {
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/TIER-000/);
  });
});
