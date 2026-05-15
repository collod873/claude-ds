import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/a11y-scan.ts");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "int-a11y-"));
}

describe("a11y-scan.ts [integration]", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("stub: exit 0 when axe-core in devDependencies", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { "axe-core": "^4.0.0" } })
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/TODO|axe-core/i);
  });

  it("exit 1, stderr A11Y-000 when axe-core missing", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: {} })
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/A11Y-000/);
  });
});
