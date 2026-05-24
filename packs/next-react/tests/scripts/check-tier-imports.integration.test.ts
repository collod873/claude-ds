import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/check-tier-imports.ts");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "int-tier-"));
}

describe("check-tier-imports.ts [integration]", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("exit 0 for clean DS files", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(join(atomsDir, "Clean.tsx"), `import React from "react";\nexport const Clean = () => null;\n`);

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });

  it("exit 2 with TIER-001 stderr in contract format for atom importing composites", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(
      join(atomsDir, "Bad.tsx"),
      `import { X } from "../design-system/composites/X";\n`
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^[^:]+:\d+: TIER-001: /m);
  });

  it("exit 2 with TIER-002 when composite imports from app/", async () => {
    const compositesDir = join(dir, "design-system", "composites");
    await mkdir(compositesDir, { recursive: true });
    await writeFile(
      join(compositesDir, "BadComposite.tsx"),
      `import { MyPage } from "../../app/my-page";\nexport const BadComposite = () => null;\n`
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/TIER-002/);
  });

  it("exit 2 with TIER-003 when DS file imports from src/", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(
      join(atomsDir, "SrcAtom.tsx"),
      `import { util } from "src/utils";\nexport const SrcAtom = () => null;\n`
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/TIER-003/);
  });

  it("exit 1 with TIER-000 when design-system/ is missing", () => {
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/TIER-000/);
  });
});
