import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCRIPT = resolve("packs/next-react/files/scripts/build-manifest.ts");

describe("build-manifest.ts — references + kind + path_no_ext", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "int-bm-refs-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("scans references/, parses meta.kind, and emits kind + path_no_ext for all entries", async () => {
    const dsRoot = join(dir, "design-system");
    await mkdir(join(dsRoot, "atoms"), { recursive: true });
    await mkdir(join(dsRoot, "composites"), { recursive: true });
    await mkdir(join(dsRoot, "references"), { recursive: true });

    await writeFile(
      join(dsRoot, "atoms", "Button.tsx"),
      `export const meta = { kind: "atom", examples: [] };\nexport const Button = () => null;\n`
    );
    await writeFile(
      join(dsRoot, "composites", "Card.tsx"),
      `export const meta = { kind: "composite", examples: [] };\nexport const Card = () => null;\n`
    );
    await writeFile(
      join(dsRoot, "references", "tokens.tsx"),
      `export const meta = { kind: "reference", title: "Design Tokens", render: () => null };\n`
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);

    const manifest = JSON.parse(readFileSync(join(dsRoot, "manifest.json"), "utf8"));
    const byName = (n: string) => manifest.components.find((c: { name: string }) => c.name === n);

    expect(byName("Button").kind).toBe("atom");
    expect(byName("Button").path_no_ext).toBe("design-system/atoms/Button");
    expect(byName("Card").kind).toBe("composite");
    expect(byName("Card").path_no_ext).toBe("design-system/composites/Card");
    expect(byName("tokens").kind).toBe("reference");
    expect(byName("tokens").path_no_ext).toBe("design-system/references/tokens");
  });

  it("infers kind from directory + warns when meta.kind is missing", async () => {
    const dsRoot = join(dir, "design-system");
    await mkdir(join(dsRoot, "atoms"), { recursive: true });
    await writeFile(join(dsRoot, "atoms", "Bare.tsx"), `export const Bare = () => null;\n`);

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/MFST-002/);

    const manifest = JSON.parse(readFileSync(join(dsRoot, "manifest.json"), "utf8"));
    const bare = manifest.components.find((c: { name: string }) => c.name === "Bare");
    expect(bare.kind).toBe("atom");
  });
});
