import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { classifyCmd } from "../../src/commands/classify";
import type { FixerPrompt } from "../../src/lib/drift/index.js";

// PRD #241 / sub-issue #247 — the CI proof that the surgical-audit,
// classify-rewrite, and one-boundary fixes compose into a converging flow.
//
// The shape we are protecting against:
//   classify → audit --fix → audit --fix
// must reach a fixed point — the second `audit --fix` produces zero bytes of
// change and zero `INTEGRITY-UNRESOLVABLE-IMPORT`, and the final `audit` exits
// 0. The HITL run that motivated PRD #241 failed exactly here (243 fixes, 13
// errors, then 14 errors on a second pass — non-idempotent and self-worsening).
//
// Assertions are external-behavior only — file locations, finding rule IDs,
// importer resolvability (via INTEGRITY-UNRESOLVABLE-IMPORT absence), exit
// codes, and a tree-snapshot diff. We never assert which function emitted
// which byte.

const BASE_CFG = {
  packVersion: "v0.9.0",
  pack: "next-react",
  mode: "warn",
  domain_roots: ["features", "lib"],
  ds_aliases: ["@ds"],
};

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(absDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(absDir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const rel = relative(root, abs);
        result.set(rel, await readFile(abs, "utf8"));
      }
    }
  }
  await walk(root);
  return result;
}

function diffTrees(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const changes: string[] = [];
  for (const [path, content] of after) {
    const prev = before.get(path);
    if (prev === undefined) changes.push(`added: ${path}`);
    else if (prev !== content) changes.push(`changed: ${path}`);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push(`removed: ${path}`);
  }
  return changes;
}

describe("brownfield flow converges (PRD #241 / sub-issue #247)", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await freshTmpDir();
    // Silence classifyCmd's console.log (info()) — the runCli helper captures
    // its own output, but classifyCmd here runs directly so its prints leak
    // to the vitest reporter without a spy.
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    logSpy.mockRestore();
    await cleanup(dir);
  });

  it("classify → audit --fix is a fixed point: second --fix is 0 changes / 0 unresolvable imports, final audit exits 0", async () => {
    // ── Brownfield fixture ──
    //
    // Mirrors the failing HITL shape: an atom that the classifier considers
    // composite (3+ DS imports), plus DS-internal and app-code importers that
    // would dangle if the move didn't carry an importer rewrite.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await mkdir(join(dir, "src/app"), { recursive: true });
    await mkdir(join(dir, "src/features/dashboard"), { recursive: true });

    // Three plain atoms — no DS imports, classifier confidently atom.
    for (const name of ["button", "input", "badge"]) {
      const Name = name[0].toUpperCase() + name.slice(1);
      await writeFile(
        join(dir, `design-system/atoms/${name}.tsx`),
        `export function ${Name}() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      );
    }

    // combo: lives in atoms/, imports 3 DS atoms — at/above
    // COMPOSITE_CONFIDENCE_THRESHOLD so classify's ambiguity prompt fires.
    // The prompt answer below is "Move to composites" (1).
    await writeFile(
      join(dir, "design-system/atoms/combo.tsx"),
      [
        `import { Button } from "@ds/atoms/button";`,
        `import { Input } from "@ds/atoms/input";`,
        `import { Badge } from "@ds/atoms/badge";`,
        `export function Combo() { return <div><Button/><Input/><Badge/></div>; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
        "",
      ].join("\n"),
    );

    // DS-internal importer of the about-to-move file — must be rewritten or
    // INTEGRITY-UNRESOLVABLE-IMPORT will fire on the next audit. (DS files
    // are the only ones audit walks for integrity, so this is the importer
    // class the HITL run actually surfaced as broken.)
    await writeFile(
      join(dir, "design-system/atoms/uses-combo.tsx"),
      [
        `import { Combo } from "@ds/atoms/combo";`,
        `export function UsesCombo() { return <Combo/>; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
        "",
      ].join("\n"),
    );

    // App-code importers in both alias flavors — story 9's regression surface.
    await writeFile(
      join(dir, "src/app/page.tsx"),
      `import { Combo } from "@ds/atoms/combo";\nexport default function Page() { return <Combo/>; }\n`,
    );
    await writeFile(
      join(dir, "src/features/dashboard/widget.tsx"),
      `import { Combo } from "@/design-system/atoms/combo";\nexport function Widget() { return <Combo/>; }\n`,
    );

    // ── classify: ambiguity prompt fires, combo moves atoms → composites,
    //    every importer is rewritten by the post-move rewriteImports pass. ──
    const prompt: FixerPrompt = async () => 1;
    await classifyCmd({ cwd: dir, prompt });

    // ── First audit --fix from the post-classify state ──
    const fix1 = await runCli(["audit", "--fix"], { cwd: dir });
    expect(fix1.stdout).not.toMatch(/INTEGRITY-UNRESOLVABLE-IMPORT/);

    // ── Convergence claim: a second `audit --fix` is a fixed point. ──
    // Zero bytes change between snapshots, no new dangling imports surface.
    const treeBefore = await snapshotTree(dir);
    const fix2 = await runCli(["audit", "--fix"], { cwd: dir });
    const treeAfter = await snapshotTree(dir);

    expect(fix2.stdout).not.toMatch(/INTEGRITY-UNRESOLVABLE-IMPORT/);
    expect(diffTrees(treeBefore, treeAfter)).toEqual([]);

    // ── Final read-only audit on the converged tree exits 0. ──
    const audit = await runCli(["audit"], { cwd: dir });
    expect(audit.stdout).not.toMatch(/INTEGRITY-UNRESOLVABLE-IMPORT/);
    expect(audit.code).toBe(0);
  }, 15000);

  it("a file with BOTH a duplicate decl and an unresolved symbol heals in ONE pass (#260)", async () => {
    // The convergence bug this guards: a file carrying both integrity findings
    // (INTEGRITY-DUPLICATE-DECL + INTEGRITY-UNRESOLVED-SYMBOL) produced two ops in
    // one plan-all-then-apply batch. Both planned against the same on-disk bytes,
    // so the second write clobbered the first — the file needed two `audit --fix`
    // passes and pass 2 was not a fixed point (failed acceptance #2). The fixers
    // must now compose in a single pass: dedup AND the re-derived import both land.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    // tsconfig `paths` is what the sibling-DS resolver reads to mint a canonical
    // import specifier for a DS-defined symbol.
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@ds/*": ["./design-system/*"] } } }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });

    // A sibling atom that DEFINES `Helper` — tier-1 resolvable.
    await writeFile(
      join(dir, "design-system/atoms/helper.tsx"),
      `export function Helper() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
    );

    // The corrupt atom: references `Helper` with no import (UNRESOLVED-SYMBOL,
    // provable) AND declares `Dup` twice, verbatim (DUPLICATE-DECL, mergeable).
    await writeFile(
      join(dir, "design-system/atoms/broken.tsx"),
      [
        `export function Broken() { return <div><Helper/><Dup/></div>; }`,
        `function Dup() { return <span/>; }`,
        `function Dup() { return <span/>; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
        "",
      ].join("\n"),
    );

    // ── One `audit --fix` pass must fully heal the file. ──
    await runCli(["audit", "--fix"], { cwd: dir });
    const healed = await readFile(join(dir, "design-system/atoms/broken.tsx"), "utf8");

    // Both fixes landed in the SAME pass: the import was re-derived AND the
    // duplicate decl was merged to a single implementation.
    expect(healed).toMatch(/import\s+\{\s*Helper\s*\}\s+from\s+["']@ds\/atoms\/helper["']/);
    expect(healed.match(/function Dup\b/g) ?? []).toHaveLength(1);
    expect(healed).not.toMatch(/INTEGRITY/);

    // ── Pass 2 is a fixed point: zero bytes change. ──
    const treeBefore = await snapshotTree(dir);
    await runCli(["audit", "--fix"], { cwd: dir });
    const treeAfter = await snapshotTree(dir);
    expect(diffTrees(treeBefore, treeAfter)).toEqual([]);
  }, 15000);
});
