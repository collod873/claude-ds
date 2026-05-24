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

  it("emits manifest.generated.ts with static showcase imports keyed by section/name", async () => {
    const dsRoot = join(dir, "design-system");
    await mkdir(join(dsRoot, "atoms"), { recursive: true });
    await mkdir(join(dsRoot, "composites"), { recursive: true });
    await mkdir(join(dsRoot, "references"), { recursive: true });
    await writeFile(join(dsRoot, "atoms", "Button.tsx"), "export const meta = { kind: 'atom' };\nexport const Button = () => null;");
    await writeFile(join(dsRoot, "atoms", "Button.showcase.tsx"), "export default () => null;");
    await writeFile(join(dsRoot, "composites", "Card.tsx"), "export const meta = { kind: 'composite' };\nexport const Card = () => null;");
    await writeFile(join(dsRoot, "composites", "Card.showcase.tsx"), "export default () => null;");
    await writeFile(join(dsRoot, "references", "tokens.tsx"), "export const meta = { kind: 'reference' };\n");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const genPath = join(dsRoot, "manifest.generated.ts");
    expect(existsSync(genPath)).toBe(true);

    const gen = readFileSync(genPath, "utf8");
    expect(gen).toMatch(/DO NOT EDIT/);
    expect(gen).toMatch(/import atoms_Button_showcase from "\.\/atoms\/Button\.showcase"/);
    expect(gen).toMatch(/import composites_Card_showcase from "\.\/composites\/Card\.showcase"/);
    expect(gen).not.toMatch(/tokens/);
    expect(gen).toMatch(/"atoms\/Button":\s*atoms_Button_showcase/);
    expect(gen).toMatch(/"composites\/Card":\s*composites_Card_showcase/);
    const atomsIdx = gen.indexOf("atoms_Button_showcase");
    const compositesIdx = gen.indexOf("composites_Card_showcase");
    expect(atomsIdx).toBeLessThan(compositesIdx);
  });

  it("manifest entries carry kind + path_no_ext for atoms/composites/references (#53 contract)", async () => {
    const dsRoot = join(dir, "design-system");
    await mkdir(join(dsRoot, "atoms"), { recursive: true });
    await mkdir(join(dsRoot, "composites"), { recursive: true });
    await mkdir(join(dsRoot, "references"), { recursive: true });

    await writeFile(join(dsRoot, "atoms", "Chip.tsx"), "export const meta = { kind: 'atom' };\nexport const Chip = () => null;");
    await writeFile(join(dsRoot, "composites", "Modal.tsx"), "export const meta = { kind: 'composite' };\nexport const Modal = () => null;");
    await writeFile(join(dsRoot, "references", "motion.tsx"), "export const meta = { kind: 'reference' };\n");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);

    const manifest = JSON.parse(readFileSync(join(dsRoot, "manifest.json"), "utf8"));
    for (const comp of manifest.components as Array<{ name: string; kind?: string; path_no_ext?: string; tier: string }>) {
      if (["atom", "composite", "reference"].includes(comp.kind ?? "")) {
        expect(comp.path_no_ext, `${comp.name} missing path_no_ext`).toBeTruthy();
        expect(comp.kind, `${comp.name} missing kind`).toBeTruthy();
      }
    }
  });
});
