/**
 * PRD #266 Phase A: `ProjectContext` gains a `kind: "adopted" | "pre-adopt"`
 * discriminator so the pre-`.claude-ds.json` callers (`audit --pack`,
 * `migrate-layout`) get a real frozen ctx via `loadPreAdoptProject` instead of
 * a cast-through-the-type-system fake.
 *
 * PRD #266 Phase B: `ProjectContext` gains `auditConfig: ResolvedAuditConfig`,
 * populated once at boot in both factories via `resolveAuditConfig`. This is a
 * type-and-population-only change; no consumer reads it yet.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, dirname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { loadProject, loadPreAdoptProject } from "../../src/lib/project";
import { parseManifest } from "../../src/lib/manifest";
import { DEFAULT_DOMAIN_ROOTS } from "../../src/lib/classifier";

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

describe("ProjectContext.auditConfig — PRD #266 Phase B", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("loadProject populates auditConfig from cfg + detected fallbacks", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({
        version: "v0.0.0",
        pack: "next-react",
        mode: "warn",
        domain_roots: ["pages", "modules"],
        meta_kind_strict: true,
        claude_md_target: ".claude/CLAUDE.md",
      }),
    );
    const ctx = await loadProject(dir);
    expect(ctx.auditConfig.domainRoots).toEqual(["pages", "modules"]);
    expect(ctx.auditConfig.metaKindStrict).toBe(true);
    expect(ctx.auditConfig.claudeMdTarget).toBe(".claude/CLAUDE.md");
    expect(ctx.auditConfig.appDir).toBe("app");
    expect(ctx.auditConfig.allowedImports).toEqual([]);
    expect(ctx.auditConfig.dsAliases).toEqual([]);
    expect(ctx.auditConfig.tsconfigPaths).toEqual({});
  });

  it("loadProject detects dsAliases when cfg.ds_aliases is empty", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }),
    );
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { paths: { "@ds/*": ["./design-system/*"] } },
    }));
    const ctx = await loadProject(dir);
    expect(ctx.auditConfig.dsAliases).toEqual(["@ds"]);
  });

  it("loadPreAdoptProject populates auditConfig with DEFAULT_DOMAIN_ROOTS + defaults", async () => {
    const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
    const ctx = await loadPreAdoptProject(dir, { pack: "next-react", packDir, manifest });
    expect(ctx.auditConfig.domainRoots).toEqual(DEFAULT_DOMAIN_ROOTS);
    expect(ctx.auditConfig.metaKindStrict).toBe(false);
    expect(ctx.auditConfig.allowedImports).toEqual([]);
    expect(ctx.auditConfig.appDir).toBe("app");
    expect(ctx.auditConfig.claudeMdTarget).toBe("CLAUDE.md");
  });

  it("loadPreAdoptProject detects appDir when src/app/ exists", async () => {
    await mkdir(join(dir, "src", "app"), { recursive: true });
    const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
    const ctx = await loadPreAdoptProject(dir, { pack: "next-react", packDir, manifest });
    expect(ctx.auditConfig.appDir).toBe("src/app");
  });

  it("PRD #266 parity: audit's pre-adopt cfg path yields the same domainRoots classify uses", async () => {
    // Heals the divergence PRD #266 Problem #2 lists: pre-refactor audit.ts
    // passed `cfg?.domain_roots` (possibly `undefined`) into `classifySource`
    // while classify.ts defaulted to `DEFAULT_DOMAIN_ROOTS`. With both paths
    // resolved through the same `ctx.auditConfig.domainRoots`, the pre-adopt
    // (cfg=null) branch yields DEFAULT_DOMAIN_ROOTS instead of `undefined` —
    // and the adopted branch (parseConfig defaults `domain_roots` to
    // ["features","lib"] = DEFAULT_DOMAIN_ROOTS when absent from JSON) yields
    // the same. Same source, no divergence.
    const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
    const preAdoptCtx = await loadPreAdoptProject(dir, { pack: "next-react", packDir, manifest });

    const dir2 = await freshTmpDir();
    try {
      // Config JSON omits `domain_roots` entirely — the pre-#266 audit.ts
      // would have passed `undefined` here; the resolver now backfills.
      await writeFile(
        join(dir2, ".claude-ds.json"),
        JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }),
      );
      const adoptedCtx = await loadProject(dir2);

      expect(preAdoptCtx.auditConfig.domainRoots).toEqual(DEFAULT_DOMAIN_ROOTS);
      expect(adoptedCtx.auditConfig.domainRoots).toEqual(DEFAULT_DOMAIN_ROOTS);
      expect(preAdoptCtx.auditConfig.domainRoots).toEqual(adoptedCtx.auditConfig.domainRoots);
    } finally {
      await cleanup(dir2);
    }
  });

  it("ctx (including auditConfig) is frozen on return from both factories", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }),
    );
    const adopted = await loadProject(dir);
    expect(Object.isFrozen(adopted)).toBe(true);
    expect(() => { (adopted as { auditConfig: unknown }).auditConfig = null; }).toThrow();

    const dir2 = await freshTmpDir();
    try {
      const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
      const preAdopt = await loadPreAdoptProject(dir2, { pack: "next-react", packDir, manifest });
      expect(Object.isFrozen(preAdopt)).toBe(true);
      expect(() => { (preAdopt as { auditConfig: unknown }).auditConfig = null; }).toThrow();
    } finally {
      await cleanup(dir2);
    }
  });
});
