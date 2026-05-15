import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/build-manifest.ts");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "build-manifest-"));
}

describe("build-manifest.ts", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("happy path: generates manifest.json with discovered atoms", async () => {
    const dsRoot = join(dir, "design-system");
    await mkdir(join(dsRoot, "atoms"), { recursive: true });
    await mkdir(join(dsRoot, "composites"), { recursive: true });
    await writeFile(join(dsRoot, "atoms", "Button.tsx"), "export const Button = () => null;");
    await writeFile(join(dsRoot, "atoms", "Button.states.json"), JSON.stringify([{ name: "default" }]));
    await writeFile(join(dsRoot, "atoms", "Button.showcase.tsx"), "export default () => null;");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    const manifestPath = join(dsRoot, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest).toHaveProperty("generated");
    expect(Array.isArray(manifest.components)).toBe(true);
    const button = manifest.components.find((c: { name: string }) => c.name === "Button");
    expect(button).toBeDefined();
    expect(button.tier).toBe("atom");
    expect(button.has_states).toBe(true);
    expect(button.has_showcase).toBe(true);
    expect(button.has_snapshot).toBe(false);
    expect(button.has_test).toBe(false);
  });

  it("refusal path: exits 1 with MFST-000 when design-system/ is missing", () => {
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/MFST-000/);
  });
});
