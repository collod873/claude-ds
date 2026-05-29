import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freshTmpDir, cleanup } from "../../helpers/tmpdir";
import { scanScaffoldPresence } from "../../../src/lib/reports/scaffold-presence";
import type { Manifest } from "../../../src/lib/manifest";

function makeManifest(files: Manifest["files"]): Manifest {
  return {
    files,
    canonical_paths: [],
    lookalike_ignore: [],
    deprecated_paths: [],
    managed_roots: [],
    generated_patterns: [],
  };
}

describe("scanScaffoldPresence", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await freshTmpDir("scaffold-presence-"); });
  afterEach(async () => { await cleanup(cwd); });

  it("counts present files and missing files separately", async () => {
    await mkdir(join(cwd, "design-system"), { recursive: true });
    await writeFile(join(cwd, "design-system/contracts.md"), "# contracts");

    const manifest = makeManifest([
      { path: "design-system/contracts.md", category: "seeded" },
      { path: "design-system/tokens.json", category: "seeded" },
    ]);
    const r = await scanScaffoldPresence({
      cwd, manifest, appDir: "app", claudeMdTarget: "CLAUDE.md", verbose: false,
    });
    expect(r.total).toBe(2);
    expect(r.present).toBe(1);
  });

  it("skips generated entries from the scaffold count", async () => {
    const manifest = makeManifest([
      { path: "design-system/contracts.md", category: "seeded" },
      { path: "design-system/references/tokens.showcase.tsx", category: "generated" },
    ]);
    const r = await scanScaffoldPresence({
      cwd, manifest, appDir: "app", claudeMdTarget: "CLAUDE.md", verbose: false,
    });
    expect(r.total).toBe(1);
    expect(r.present).toBe(0);
  });

  it("emits 'missing:' lines by default and omits 'present:' lines", async () => {
    await mkdir(join(cwd, "design-system"), { recursive: true });
    await writeFile(join(cwd, "design-system/contracts.md"), "# contracts");

    const manifest = makeManifest([
      { path: "design-system/contracts.md", category: "seeded" },
      { path: "design-system/tokens.json", category: "seeded" },
    ]);
    const r = await scanScaffoldPresence({
      cwd, manifest, appDir: "app", claudeMdTarget: "CLAUDE.md", verbose: false,
    });
    expect(r.lines.some(l => l.startsWith("missing: design-system/tokens.json"))).toBe(true);
    expect(r.lines.some(l => l.startsWith("present:"))).toBe(false);
  });

  it("emits 'present:' lines when verbose=true", async () => {
    await mkdir(join(cwd, "design-system"), { recursive: true });
    await writeFile(join(cwd, "design-system/contracts.md"), "# contracts");

    const manifest = makeManifest([
      { path: "design-system/contracts.md", category: "seeded" },
    ]);
    const r = await scanScaffoldPresence({
      cwd, manifest, appDir: "app", claudeMdTarget: "CLAUDE.md", verbose: true,
    });
    expect(r.lines.some(l => l.startsWith("present: design-system/contracts.md"))).toBe(true);
  });

  it("rewrites the manifest 'app/' prefix through appDir for the existence check", async () => {
    await mkdir(join(cwd, "src/app"), { recursive: true });
    await writeFile(join(cwd, "src/app/page.tsx"), "export default function() { return null }");

    const manifest = makeManifest([
      { path: "app/page.tsx", category: "managed" },
    ]);
    const r = await scanScaffoldPresence({
      cwd, manifest, appDir: "src/app", claudeMdTarget: "CLAUDE.md", verbose: true,
    });
    expect(r.present).toBe(1);
    expect(r.lines.some(l => l.includes("app/page.tsx (at src/app/page.tsx)"))).toBe(true);
  });

  it("rewrites the manifest 'CLAUDE.md' path through claudeMdTarget", async () => {
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(join(cwd, ".claude/CLAUDE.md"), "# claude");

    const manifest = makeManifest([
      { path: "CLAUDE.md", category: "managed" },
    ]);
    const r = await scanScaffoldPresence({
      cwd, manifest, appDir: "app", claudeMdTarget: ".claude/CLAUDE.md", verbose: true,
    });
    expect(r.present).toBe(1);
    expect(r.lines.some(l => l.includes("CLAUDE.md (at .claude/CLAUDE.md)"))).toBe(true);
  });
});
