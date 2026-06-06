/**
 * PRD #266 Phase A: `ProjectContext` gains a `kind: "adopted" | "pre-adopt"`
 * discriminator so the pre-`.claude-ds.json` callers (`audit --pack`,
 * `migrate-layout`) get a real frozen ctx via `loadPreAdoptProject` instead of
 * a cast-through-the-type-system fake.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, dirname, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { loadProject, loadPreAdoptProject } from "../../src/lib/project";
import { parseManifest } from "../../src/lib/manifest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const packDir = join(repoRoot, "packs", "next-react");

describe("loadProject (adopted)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("sets kind to 'adopted'", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }),
    );
    const ctx = await loadProject(dir);
    expect(ctx.kind).toBe("adopted");
  });

  it("returns a frozen ctx", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }),
    );
    const ctx = await loadProject(dir);
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});

describe("loadPreAdoptProject (pre-adopt)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("returns a frozen ctx with kind 'pre-adopt'", async () => {
    const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
    const ctx = await loadPreAdoptProject(dir, { pack: "next-react", packDir, manifest });
    expect(ctx.kind).toBe("pre-adopt");
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it("carries a partial cfg with only `pack`", async () => {
    const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
    const ctx = await loadPreAdoptProject(dir, { pack: "next-react", packDir, manifest });
    expect(ctx.cfg.pack).toBe("next-react");
  });

  it("carries cwd, packDir, manifest, exists, decisions", async () => {
    const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
    const ctx = await loadPreAdoptProject(dir, { pack: "next-react", packDir, manifest });
    expect(ctx.cwd).toBe(dir);
    expect(ctx.packDir).toBe(packDir);
    expect(ctx.manifest).toBe(manifest);
    expect(typeof ctx.exists).toBe("function");
    expect(ctx.decisions).toEqual({});
  });

  it("exists() resolves relative paths against cwd", async () => {
    const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
    await writeFile(join(dir, "hello.txt"), "");
    const ctx = await loadPreAdoptProject(dir, { pack: "next-react", packDir, manifest });
    expect(await ctx.exists("hello.txt")).toBe(true);
    expect(await ctx.exists("nope.txt")).toBe(false);
  });
});
