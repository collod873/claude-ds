import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/a11y-scan.ts");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "a11y-scan-"));
}

describe("a11y-scan.ts", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("happy path (stub): exits 0 when axe-core is in devDependencies", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "test-app",
        devDependencies: { "axe-core": "^4.0.0" },
      })
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/TODO.*post-Slice H|axe-core found/i);
  });

  it("refusal path: exits 1 with A11Y-000 when axe-core is absent", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "test-app",
        devDependencies: {},
      })
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/A11Y-000/);
  });
});
