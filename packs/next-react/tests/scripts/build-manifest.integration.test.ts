import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const SCRIPT = resolve("packs/next-react/files/scripts/build-manifest.ts");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "int-build-manifest-"));
}

describe("build-manifest.ts [integration]", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("end-to-end: generates manifest.json with correct structure", async () => {
    const dsRoot = join(dir, "design-system");
    await mkdir(join(dsRoot, "atoms"), { recursive: true });
    await mkdir(join(dsRoot, "composites"), { recursive: true });
    await writeFile(join(dsRoot, "atoms", "Chip.tsx"), "export const Chip = () => null;");
    await writeFile(join(dsRoot, "atoms", "Chip.states.json"), JSON.stringify([{ label: "default" }]));
    await writeFile(join(dsRoot, "composites", "Card.tsx"), "export const Card = () => null;");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    expect(existsSync(join(dsRoot, "manifest.json"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(dsRoot, "manifest.json"), "utf8"));
    expect(typeof manifest.generated).toBe("string");
    expect(Array.isArray(manifest.components)).toBe(true);

    const chip = manifest.components.find((c: { name: string }) => c.name === "Chip");
    expect(chip).toBeDefined();
    expect(chip.tier).toBe("atom");
    expect(chip.has_states).toBe(true);

    const card = manifest.components.find((c: { name: string }) => c.name === "Card");
    expect(card).toBeDefined();
    expect(card.tier).toBe("composite");
  });

  it("exit code 1 and stderr MFST-000 when design-system/ missing", () => {
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/MFST-000/);
  });
});
