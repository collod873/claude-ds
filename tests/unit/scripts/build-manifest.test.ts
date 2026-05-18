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
    expect(button.has_test).toBe(false);
  });

  it("emits manifest.generated.ts with static showcase imports keyed by section/name", async () => {
    const dsRoot = join(dir, "design-system");
    await mkdir(join(dsRoot, "atoms"), { recursive: true });
    await mkdir(join(dsRoot, "composites"), { recursive: true });
    await mkdir(join(dsRoot, "references"), { recursive: true });
    // atom with showcase
    await writeFile(join(dsRoot, "atoms", "Button.tsx"), "export const meta = { kind: 'atom' };\nexport const Button = () => null;");
    await writeFile(join(dsRoot, "atoms", "Button.showcase.tsx"), "export default () => null;");
    // composite with showcase
    await writeFile(join(dsRoot, "composites", "Card.tsx"), "export const meta = { kind: 'composite' };\nexport const Card = () => null;");
    await writeFile(join(dsRoot, "composites", "Card.showcase.tsx"), "export default () => null;");
    // reference — no showcase
    await writeFile(join(dsRoot, "references", "tokens.tsx"), "export const meta = { kind: 'reference' };\n");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const genPath = join(dsRoot, "manifest.generated.ts");
    expect(existsSync(genPath)).toBe(true);

    const gen = readFileSync(genPath, "utf8");

    // Must have "do not edit" header
    expect(gen).toMatch(/DO NOT EDIT/);

    // Static import for Button showcase — relative, no @/ alias
    expect(gen).toMatch(/import atoms_Button_showcase from "\.\/atoms\/Button\.showcase"/);
    // Static import for Card showcase
    expect(gen).toMatch(/import composites_Card_showcase from "\.\/composites\/Card\.showcase"/);
    // tokens has no showcase — must NOT appear as an import
    expect(gen).not.toMatch(/tokens/);

    // Exported map keys use section/name path (matching ManifestEntry.path_no_ext minus "design-system/")
    expect(gen).toMatch(/"atoms\/Button":\s*atoms_Button_showcase/);
    expect(gen).toMatch(/"composites\/Card":\s*composites_Card_showcase/);

    // Imports must be sorted (atoms before composites)
    const atomsIdx = gen.indexOf("atoms_Button_showcase");
    const compositesIdx = gen.indexOf("composites_Card_showcase");
    expect(atomsIdx).toBeLessThan(compositesIdx);
  });

  it("manifest.generated.ts satisfies ManifestEntry contract: kind + path_no_ext populated for atoms/composites/references", async () => {
    // This test guards the #53 contract: the catch-all page relies on kind and path_no_ext
    // being present for all atoms, composites, and references in manifest.json.
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
      // Every atom/composite/reference must have kind and path_no_ext
      if (["atom", "composite", "reference"].includes(comp.kind ?? "")) {
        expect(comp.path_no_ext, `${comp.name} missing path_no_ext`).toBeTruthy();
        expect(comp.kind, `${comp.name} missing kind`).toBeTruthy();
      }
    }
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
