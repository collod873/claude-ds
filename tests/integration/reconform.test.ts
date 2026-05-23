import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Minimal adopted project state with an atoms component dir. */
async function scaffoldProject(dir: string) {
  await writeFile(
    join(dir, ".claude-ds.json"),
    JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" })
  );
  await mkdir(join(dir, "design-system", "atoms"), { recursive: true });
  await mkdir(join(dir, "design-system", "composites"), { recursive: true });
  await writeFile(join(dir, "design-system", "exceptions.json"), JSON.stringify({ exceptions: [] }));
  // stub contracts + tokens with enough lines to avoid stub-warning (≥25)
  const lines25 = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n");
  await writeFile(join(dir, "design-system", "contracts.md"), lines25);
  await writeFile(join(dir, "design-system", "tokens.json"), JSON.stringify(Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [`token${i}`, `value${i}`])
  ), null, 2));
}

/** Create a flat component file in atoms (no subdirectory). */
async function addAtomFile(dir: string, name: string) {
  await writeFile(
    join(dir, "design-system", "atoms", `${name}.tsx`),
    `export const ${name} = () => null;\n`
  );
}

describe("reconform", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshTmpDir("claude-ds-reconform-");
  });
  afterEach(async () => { await cleanup(dir); });

  it("happy path: generates missing companion stubs for flat-layout atoms", async () => {
    await scaffoldProject(dir);
    await addAtomFile(dir, "button");
    await addAtomFile(dir, "badge");

    const r = await runCli(["reconform"], { cwd: dir });
    expect(r.code).toBe(0);

    // Each flat atom should now have sibling .showcase.tsx, .states.json, .test.tsx
    for (const name of ["button", "badge"]) {
      const base = join(dir, "design-system", "atoms", name);
      await stat(`${base}.showcase.tsx`);
      await stat(`${base}.states.json`);
      await stat(`${base}.test.tsx`);
    }

    // Showcase stub should contain the TODO marker
    const showcaseContent = await readFile(
      join(dir, "design-system", "atoms", "button.showcase.tsx"),
      "utf8"
    );
    expect(showcaseContent).toMatch(/TODO\(claude-ds\):/);

    // States stub should be valid JSON
    const statesContent = await readFile(
      join(dir, "design-system", "atoms", "button.states.json"),
      "utf8"
    );
    expect(() => JSON.parse(statesContent)).not.toThrow();

    // Test stub should contain the TODO marker
    const testContent = await readFile(
      join(dir, "design-system", "atoms", "button.test.tsx"),
      "utf8"
    );
    expect(testContent).toMatch(/TODO\(claude-ds\):/);
  });

  it("dry-run: no files written, exit 0", async () => {
    await scaffoldProject(dir);
    await addAtomFile(dir, "card");

    const r = await runCli(["reconform", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/dry-run/i);

    // No companion files should have been created (flat siblings)
    const atomsDir = join(dir, "design-system", "atoms");
    const companionExists = async (name: string) => {
      try { await stat(join(atomsDir, name)); return true; } catch { return false; }
    };
    expect(await companionExists("card.showcase.tsx")).toBe(false);
    expect(await companionExists("card.states.json")).toBe(false);
    expect(await companionExists("card.test.tsx")).toBe(false);
  });

  it("precondition failure: no .claude-ds.json → exit 2 with message", async () => {
    // dir is fresh with no files at all
    const r = await runCli(["reconform"], { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/\.claude-ds\.json/i);
  });

  it("kebab-case filename → PascalCase identifiers in stubs, kebab in import path", async () => {
    await scaffoldProject(dir);
    // Add a kebab-case component (the bug case)
    await writeFile(
      join(dir, "design-system", "atoms", "top-bar.tsx"),
      `export function TopBar() { return null; }\n`
    );

    const r = await runCli(["reconform"], { cwd: dir });
    expect(r.code).toBe(0);

    const showcaseContent = await readFile(
      join(dir, "design-system", "atoms", "top-bar.showcase.tsx"),
      "utf8"
    );
    // import uses namespace pattern, function name uses PascalCase
    expect(showcaseContent).toContain(`import * as Mod from "./top-bar"`);
    expect(showcaseContent).toContain(`void Mod`);
    expect(showcaseContent).toContain(`return null`);
    expect(showcaseContent).toContain(`function TopBarShowcase()`);
    // new stub must NOT render with unknown props or import testing-library
    expect(showcaseContent).not.toContain("@testing-library");
    expect(showcaseContent).not.toContain("<TopBar");
    // must NOT contain the old named PascalCase import
    expect(showcaseContent).not.toContain(`import { TopBar }`);
    expect(showcaseContent).not.toContain(`void TopBar`);
    // must NOT contain the raw kebab identifier (would be a syntax error)
    expect(showcaseContent).not.toContain("{ top-bar }");
    expect(showcaseContent).not.toContain("top-barShowcase");

    const testContent = await readFile(
      join(dir, "design-system", "atoms", "top-bar.test.tsx"),
      "utf8"
    );
    expect(testContent).toContain(`import * as Mod from "./top-bar"`);
    expect(testContent).toContain(`expect(Mod).toBeDefined()`);
    expect(testContent).toContain(`describe("TopBar"`);
    // new stub must NOT import testing-library or use render
    expect(testContent).not.toContain("@testing-library");
    expect(testContent).not.toContain("render");
    expect(testContent).not.toContain("{ top-bar }");
  });

  it("stub warning: contracts.md and tokens.json under threshold → warning printed", async () => {
    await scaffoldProject(dir);
    // Overwrite the full-length files with short stubs (< 25 lines)
    await writeFile(join(dir, "design-system", "contracts.md"), "# stub\n");
    await writeFile(join(dir, "design-system", "tokens.json"), "{}");

    const r = await runCli(["reconform"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/stub|WARNING/i);
    expect(r.stdout).toMatch(/contracts\.md|tokens\.json/i);
  });

  it("check phase: invokes project-local scripts/check-*.ts (not pack-internal)", async () => {
    // Issue #16 — check scripts live in <project>/scripts/ after sync,
    // not inside the pack distribution. Reconform must resolve them there.
    await scaffoldProject(dir);
    await mkdir(join(dir, "scripts"), { recursive: true });

    // A minimal check script that always reports one violation (exit 2 + stderr line)
    const checkScript = [
      `process.stderr.write("design-system/atoms/button.tsx:1: TST-001: sentinel violation\\n");`,
      `process.exit(2);`,
    ].join("\n");
    await writeFile(join(dir, "scripts", "check-sentinel.ts"), checkScript);

    const r = await runCli(["reconform", "--dry-run"], { cwd: dir });
    // dry-run prints violations it found without prompting
    expect(r.stdout).toMatch(/sentinel violation|TST-001/i);
  });

  // ── Meta-export validation (issue #40) ─────────────────────────────────────

  it("meta check: component missing export const meta → reported", async () => {
    await scaffoldProject(dir);
    // Component without meta export
    await writeFile(
      join(dir, "design-system", "atoms", "button.tsx"),
      `export function Button() { return null; }\n`
    );

    const r = await runCli(["reconform", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/META-001/);
    expect(r.stdout).toMatch(/button\.tsx/);
  });

  it("meta check: component with export const meta → not reported", async () => {
    await scaffoldProject(dir);
    await writeFile(
      join(dir, "design-system", "atoms", "button.tsx"),
      [
        `import type { Meta } from "../types/meta";`,
        `export const meta: Meta = {`,
        `  kind: "atom",`,
        `  examples: [{ name: "default", props: {} }],`,
        `};`,
        `export function Button() { return null; }`,
        ``,
      ].join("\n")
    );

    const r = await runCli(["reconform", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/META-001/);
  });

  it("meta check: companion files (.showcase.tsx, .test.tsx) exempt from meta requirement", async () => {
    await scaffoldProject(dir);
    // Main component has meta; companions don't (they shouldn't need to).
    // Companion .test.tsx alone is sufficient: meta-audit treats .showcase.tsx,
    // .test.tsx, and .stories.tsx symmetrically via COMPANION_SUFFIXES. We omit
    // .showcase.tsx here to keep the dry-run baseline free of GEN-001/002
    // violations under the new policy (#89); GEN drift is covered separately.
    await writeFile(
      join(dir, "design-system", "atoms", "badge.tsx"),
      `export const meta = { kind: "atom", examples: [] };\nexport function Badge() { return null; }\n`
    );
    await writeFile(
      join(dir, "design-system", "atoms", "badge.test.tsx"),
      `import { describe, it } from "vitest";\ndescribe("Badge", () => { it("loads", () => {}); });\n`
    );

    const r = await runCli(["reconform", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    // No META-001 for badge (main file has meta, companions are exempt)
    expect(r.stdout).not.toMatch(/META-001/);
  });

  // ── #89: dry-run exit-2 on GEN-001/002 violations ──────────────────────────

  it("#89: --dry-run with GEN-001 violation exits 2 and prints the violation", async () => {
    await scaffoldProject(dir);
    await writeFile(
      join(dir, "design-system", "atoms", "tag.tsx"),
      [
        `import type { Meta } from "@/design-system/types/meta";`,
        `export const meta: Meta = { kind: "atom", examples: [{ name: "default", props: {} }] };`,
        `export function Tag() { return null; }`,
        ``,
      ].join("\n")
    );
    // Companion exists but missing @generated header → GEN-001 violation.
    await writeFile(
      join(dir, "design-system", "atoms", "tag.showcase.tsx"),
      `// hand-written stub\nexport default function TagShowcase() { return null; }\n`
    );

    const r = await runCli(["reconform", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/GEN-001/);
    expect(r.stderr).toMatch(/tag\.showcase\.tsx/);
  });

  it("#89: --dry-run with no GEN violations exits 0", async () => {
    await scaffoldProject(dir);
    // Atom with meta, no companions → integrity check finds nothing.
    await writeFile(
      join(dir, "design-system", "atoms", "label.tsx"),
      [
        `import type { Meta } from "@/design-system/types/meta";`,
        `export const meta: Meta = { kind: "atom", examples: [{ name: "default", props: {} }] };`,
        `export function Label() { return null; }`,
        ``,
      ].join("\n")
    );

    const r = await runCli(["reconform", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
  });

  it("meta check: references dir scanned — reference file missing meta → reported", async () => {
    await scaffoldProject(dir);
    await mkdir(join(dir, "design-system", "references"), { recursive: true });
    await writeFile(
      join(dir, "design-system", "references", "tokens.tsx"),
      `export default function TokensPage() { return null; }\n`
    );

    const r = await runCli(["reconform", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/META-001/);
    expect(r.stdout).toMatch(/tokens\.tsx/);
  });

  it("meta check: reference file with kind=reference meta → not reported", async () => {
    await scaffoldProject(dir);
    await mkdir(join(dir, "design-system", "references"), { recursive: true });
    await writeFile(
      join(dir, "design-system", "references", "tokens.tsx"),
      [
        `import type { Meta } from "../types/meta";`,
        `export const meta: Meta = {`,
        `  kind: "reference",`,
        `  title: "Design Tokens",`,
        `  render: () => null,`,
        `};`,
        `export default function TokensPage() { return null; }`,
        ``,
      ].join("\n")
    );

    const r = await runCli(["reconform", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/META-001/);
  });

  // ── --backfill-meta flag (issue #41) ───────────────────────────────────────

  it("--backfill-meta --fix: appends meta stub to atom without cva", async () => {
    await scaffoldProject(dir);
    await writeFile(
      join(dir, "design-system", "atoms", "button.tsx"),
      `export function Button() { return null; }\n`
    );

    const r = await runCli(["reconform", "--backfill-meta", "--fix"], { cwd: dir });
    expect(r.code).toBe(0);

    const content = await readFile(join(dir, "design-system", "atoms", "button.tsx"), "utf8");
    expect(content).toMatch(/export const meta/);
    expect(content).toMatch(/kind:\s*"atom"/);
    expect(content).toMatch(/examples/);
    // No skip[] without cva
    expect(content).not.toMatch(/skip:\s*\[\]/);
  });

  it("--backfill-meta --fix: appends meta stub with skip[] when cva present", async () => {
    await scaffoldProject(dir);
    await writeFile(
      join(dir, "design-system", "atoms", "badge.tsx"),
      `import { cva } from "class-variance-authority";\nconst badge = cva("b", {});\nexport function Badge() { return null; }\n`
    );

    const r = await runCli(["reconform", "--backfill-meta", "--fix"], { cwd: dir });
    expect(r.code).toBe(0);

    const content = await readFile(join(dir, "design-system", "atoms", "badge.tsx"), "utf8");
    expect(content).toMatch(/export const meta/);
    expect(content).toMatch(/kind:\s*"atom"/);
    expect(content).toMatch(/skip/);
  });

  it("--backfill-meta --fix: reference file gets title + render:null stub", async () => {
    await scaffoldProject(dir);
    await mkdir(join(dir, "design-system", "references"), { recursive: true });
    await writeFile(
      join(dir, "design-system", "references", "design-tokens.tsx"),
      `export default function DesignTokensPage() { return null; }\n`
    );

    const r = await runCli(["reconform", "--backfill-meta", "--fix"], { cwd: dir });
    expect(r.code).toBe(0);

    const content = await readFile(join(dir, "design-system", "references", "design-tokens.tsx"), "utf8");
    expect(content).toMatch(/export const meta/);
    expect(content).toMatch(/kind:\s*"reference"/);
    expect(content).toMatch(/title:\s*"Design Tokens"/);
    expect(content).toMatch(/render:\s*\(\)\s*=>/);
    expect(content).toMatch(/TODO\(claude-ds\)/);
  });

  it("--backfill-meta --fix: file already with meta is not touched", async () => {
    await scaffoldProject(dir);
    const originalContent = [
      `import type { Meta } from "../types/meta";`,
      `export const meta: Meta = { kind: "atom", examples: [{ name: "default", props: {} }] };`,
      `export function Chip() { return null; }`,
      ``,
    ].join("\n");
    await writeFile(join(dir, "design-system", "atoms", "chip.tsx"), originalContent);

    const r = await runCli(["reconform", "--backfill-meta", "--fix"], { cwd: dir });
    expect(r.code).toBe(0);

    // File should be unchanged (no double-appending)
    const content = await readFile(join(dir, "design-system", "atoms", "chip.tsx"), "utf8");
    expect(content).toBe(originalContent);
  });

  it("--backfill-meta (no --fix): reports missing meta but does not write", async () => {
    await scaffoldProject(dir);
    await writeFile(
      join(dir, "design-system", "atoms", "card.tsx"),
      `export function Card() { return null; }\n`
    );

    const r = await runCli(["reconform", "--backfill-meta"], { cwd: dir });
    expect(r.code).toBe(0);
    // Should still report missing
    expect(r.stdout).toMatch(/META-001/);
    // But should not write stub (file unchanged)
    const content = await readFile(join(dir, "design-system", "atoms", "card.tsx"), "utf8");
    expect(content).not.toMatch(/export const meta/);
  });

  // ── Classification audit (issue #41) ──────────────────────────────────────

  it("--backfill-meta: reports atom importing @/design-system/* as CLASS-001 misclassified", async () => {
    await scaffoldProject(dir);
    await writeFile(
      join(dir, "design-system", "atoms", "combobox.tsx"),
      `import { Button } from "@/design-system/atoms/button";\nexport function Combobox() { return null; }\n`
    );

    const r = await runCli(["reconform", "--backfill-meta"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/CLASS-001/);
    expect(r.stdout).toMatch(/combobox/);
    expect(r.stdout).toMatch(/atom.*composite|should be composite/i);
  });

  it("--backfill-meta: correctly classified atom (no DS imports) has no CLASS-001", async () => {
    await scaffoldProject(dir);
    await writeFile(
      join(dir, "design-system", "atoms", "label.tsx"),
      `export function Label({ text }: { text: string }) { return <span>{text}</span>; }\n`
    );

    const r = await runCli(["reconform", "--backfill-meta"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/CLASS-001/);
  });

  // ── #48 / #49 / #50 / GEN-001 regressions ─────────────────────────────────

  it("#48: --backfill-meta --fix injects `import type { Meta }` when absent + appends export", async () => {
    await scaffoldProject(dir);
    const original = `"use client";\n\nimport { useState } from "react";\n\nexport function Accordion() { return null; }\n`;
    await writeFile(join(dir, "design-system", "atoms", "accordion.tsx"), original);

    const r = await runCli(["reconform", "--backfill-meta", "--fix"], { cwd: dir });
    expect(r.code).toBe(0);

    const content = await readFile(join(dir, "design-system", "atoms", "accordion.tsx"), "utf8");
    // Both must exist
    expect(content).toMatch(/import type \{ Meta \} from "@\/design-system\/types\/meta"/);
    expect(content).toMatch(/export const meta:\s*Meta\s*=/);
    // 'use client' must remain at top (line 1)
    expect(content.split("\n")[0]).toBe(`"use client";`);
    // Existing `useState` import preserved
    expect(content).toMatch(/import \{ useState \} from "react"/);
    // Meta import sits in the import block (before the function)
    const importIdx = content.indexOf("import type { Meta }");
    const fnIdx = content.indexOf("export function Accordion");
    expect(importIdx).toBeGreaterThan(0);
    expect(importIdx).toBeLessThan(fnIdx);
  });

  it("#48: --backfill-meta --fix does NOT duplicate Meta import when source already has it", async () => {
    await scaffoldProject(dir);
    // File missing `meta` export but already importing Meta type (typed elsewhere or anticipated)
    const original = [
      `import type { Meta } from "@/design-system/types/meta";`,
      `// note: this file is mid-migration — Meta import staged ahead of export`,
      `export function Button() { return null; }`,
      ``,
    ].join("\n");
    await writeFile(join(dir, "design-system", "atoms", "button.tsx"), original);

    const r = await runCli(["reconform", "--backfill-meta", "--fix"], { cwd: dir });
    expect(r.code).toBe(0);

    const content = await readFile(join(dir, "design-system", "atoms", "button.tsx"), "utf8");
    const imports = content.match(/import type \{ Meta \}/g) ?? [];
    expect(imports.length).toBe(1);
    expect(content).toMatch(/export const meta:\s*Meta\s*=/);
  });

  it("#48: backfilled file passes tsc --noEmit (real compile)", async () => {
    // Build a minimal tsc-able fixture: tsconfig + types/meta.ts + component.
    await scaffoldProject(dir);
    await mkdir(join(dir, "design-system", "types"), { recursive: true });
    await writeFile(
      join(dir, "design-system", "types", "meta.ts"),
      `export type Meta = { kind: "atom" | "composite" | "reference"; [k: string]: unknown };\n`
    );
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
          strict: true, esModuleInterop: true, skipLibCheck: true,
          noEmit: true, baseUrl: ".",
          paths: { "@/design-system/*": ["design-system/*"] },
        },
        // Only the component file we backfilled + the Meta type it imports.
        // Companion .showcase.tsx / .test.tsx require react/vitest which are
        // out-of-scope for this fixture.
        include: ["design-system/atoms/card.tsx", "design-system/types/meta.ts"],
      }, null, 2)
    );
    await writeFile(
      join(dir, "design-system", "atoms", "card.tsx"),
      `export function Card() { return null; }\n`
    );

    const r = await runCli(["reconform", "--backfill-meta", "--fix"], { cwd: dir });
    expect(r.code).toBe(0);

    const after = await readFile(join(dir, "design-system", "atoms", "card.tsx"), "utf8");
    expect(after).toMatch(/import type \{ Meta \}/);
    expect(after).toMatch(/export const meta:\s*Meta/);

    // Run tsc against the fixture. Resolve the project's tsc directly (no npx —
    // npx inside a fresh tmp dir tries to fetch from npm).
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
    const tscBin = join(projectRoot, "node_modules", ".bin", "tsc");
    const tsc = spawnSync(tscBin, ["--noEmit", "-p", "tsconfig.json"], {
      cwd: dir, encoding: "utf8", timeout: 60_000,
    });
    if (tsc.status !== 0) {
      // Surface diagnostics to make CI failures actionable
      throw new Error(`tsc failed:\n${tsc.stdout}\n${tsc.stderr}`);
    }
    expect(tsc.status).toBe(0);
  }, 90_000);

  it("#50: dry-run meta-missing count equals --fix mutation count on identical input", async () => {
    await scaffoldProject(dir);
    // Multiple components, none with meta. Includes a mix of plain, "use client", and cva variants.
    await writeFile(
      join(dir, "design-system", "atoms", "alpha.tsx"),
      `export function Alpha() { return null; }\n`
    );
    await writeFile(
      join(dir, "design-system", "atoms", "beta.tsx"),
      `"use client";\nexport function Beta() { return null; }\n`
    );
    await writeFile(
      join(dir, "design-system", "atoms", "gamma.tsx"),
      `import { cva } from "class-variance-authority";\nconst g = cva("g", {});\nexport function Gamma() { return null; }\n`
    );

    // Snapshot pre-state
    const before = await Promise.all(
      ["alpha", "beta", "gamma"].map(n => readFile(join(dir, "design-system", "atoms", `${n}.tsx`), "utf8"))
    );

    const dry = await runCli(["reconform", "--backfill-meta", "--dry-run"], { cwd: dir });
    expect(dry.code).toBe(0);
    const dryMatch = dry.stdout.match(/(\d+) meta export\(s\) missing/);
    expect(dryMatch).not.toBeNull();
    const dryCount = parseInt(dryMatch![1], 10);
    expect(dryCount).toBe(3);

    // Verify dry-run did not mutate the files
    for (let i = 0; i < 3; i++) {
      const cur = await readFile(join(dir, "design-system", "atoms", `${["alpha","beta","gamma"][i]}.tsx`), "utf8");
      expect(cur).toBe(before[i]);
    }

    const fix = await runCli(["reconform", "--backfill-meta", "--fix"], { cwd: dir });
    expect(fix.code).toBe(0);
    // Count actual mutations (files now containing `export const meta`)
    let mutated = 0;
    for (const n of ["alpha", "beta", "gamma"]) {
      const c = await readFile(join(dir, "design-system", "atoms", `${n}.tsx`), "utf8");
      if (/export const meta/.test(c)) mutated++;
    }
    expect(mutated).toBe(dryCount);
  });

  it("#49: bulk-piped R\\n<reason>\\n cycles register exception per violation", async () => {
    await scaffoldProject(dir);
    await mkdir(join(dir, "scripts"), { recursive: true });
    // A check script that emits 3 violations
    const checkScript = [
      `process.stderr.write("design-system/atoms/a.tsx:1: TST-001: violation 1\\n");`,
      `process.stderr.write("design-system/atoms/b.tsx:1: TST-001: violation 2\\n");`,
      `process.stderr.write("design-system/atoms/c.tsx:1: TST-001: violation 3\\n");`,
      `process.exit(2);`,
    ].join("\n");
    await writeFile(join(dir, "scripts", "check-multi.ts"), checkScript);

    // Pipe 3 cycles of R + reason
    const stdin = "R\nbulk migration backlog\n\nR\nbulk migration backlog\n\nR\nbulk migration backlog\n\n";
    const r = await runCli(["reconform"], { cwd: dir, stdin });
    expect(r.code).toBe(0);

    const exContent = await readFile(join(dir, "design-system", "exceptions.json"), "utf8");
    const parsed = JSON.parse(exContent);
    const tstExceptions = parsed.exceptions.filter((e: { rule: string }) => e.rule === "TST-001");
    expect(tstExceptions.length).toBe(3);
    const files = tstExceptions.map((e: { path: string }) => e.path).sort();
    expect(files).toEqual([
      "design-system/atoms/a.tsx",
      "design-system/atoms/b.tsx",
      "design-system/atoms/c.tsx",
    ]);
  });

  it("GEN-001: --fix regenerates .showcase.tsx missing @generated header (issue #51 investigation)", async () => {
    await scaffoldProject(dir);
    // Atom with meta — so the generator will produce output for it
    await writeFile(
      join(dir, "design-system", "atoms", "tag.tsx"),
      [
        `import type { Meta } from "@/design-system/types/meta";`,
        `export const meta: Meta = { kind: "atom", examples: [{ name: "default", props: {} }] };`,
        `export function Tag() { return null; }`,
        ``,
      ].join("\n")
    );
    // Stub showcase missing the @generated header
    const stubShowcase = `// hand-written stub\nexport default function TagShowcase() { return null; }\n`;
    await writeFile(join(dir, "design-system", "atoms", "tag.showcase.tsx"), stubShowcase);
    // Stub states missing __generated marker
    await writeFile(join(dir, "design-system", "atoms", "tag.states.json"), `[]\n`);
    // empty test stub so we don't hit other paths
    await writeFile(join(dir, "design-system", "atoms", "tag.test.tsx"), `// stub\n`);

    const r = await runCli(["reconform", "--fix"], { cwd: dir });
    expect(r.code).toBe(0);

    const after = await readFile(join(dir, "design-system", "atoms", "tag.showcase.tsx"), "utf8");
    expect(after.startsWith("// @generated by claude-ds")).toBe(true);
    expect(after).not.toBe(stubShowcase);

    const afterStates = await readFile(join(dir, "design-system", "atoms", "tag.states.json"), "utf8");
    const parsed = JSON.parse(afterStates);
    expect(parsed.__generated).toMatch(/@generated by claude-ds/);
  });

  it("#51: GEN-001 auto-fix runs before STATE-001 check — no spurious STATE-001 prompts after regeneration", async () => {
    // Repro: component has meta, .states.json exists but lacks __generated marker.
    // Without the fix, STATE-001 check would fire on the empty/old states.json
    // before GEN-001 had a chance to repopulate it. With the fix, GEN-001
    // unconditionally regenerates .states.json first, so STATE-001 sees the
    // populated file and stays silent.
    await scaffoldProject(dir);
    await writeFile(
      join(dir, "design-system", "atoms", "chip.tsx"),
      [
        `import type { Meta } from "@/design-system/types/meta";`,
        `export const meta: Meta = { kind: "atom", examples: [{ name: "default", props: {} }] };`,
        `export function Chip() { return null; }`,
        ``,
      ].join("\n")
    );
    // .states.json exists but lacks __generated marker (simulates pre-generation state)
    await writeFile(join(dir, "design-system", "atoms", "chip.states.json"), `[]\n`);
    await writeFile(join(dir, "design-system", "atoms", "chip.showcase.tsx"),
      `// hand-written\nexport default function ChipShowcase() { return null; }\n`);
    await writeFile(join(dir, "design-system", "atoms", "chip.test.tsx"), `// stub\n`);

    // Add a STATE-001 style check script that fires when .states.json is empty/missing __generated
    await mkdir(join(dir, "scripts"), { recursive: true });
    const checkScript = [
      `import { readFileSync, readdirSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `const cwd = process.cwd();`,
      `const atomsDir = join(cwd, "design-system", "atoms");`,
      `let violations = 0;`,
      `for (const f of readdirSync(atomsDir)) {`,
      `  if (!f.endsWith(".states.json")) continue;`,
      `  try {`,
      `    const parsed = JSON.parse(readFileSync(join(atomsDir, f), "utf8"));`,
      `    if (!parsed.__generated) {`,
      `      process.stderr.write(\`design-system/atoms/\${f}:0: STATE-001: missing __generated marker\\n\`);`,
      `      violations++;`,
      `    }`,
      `  } catch {`,
      `    process.stderr.write(\`design-system/atoms/\${f}:0: STATE-001: invalid json\\n\`);`,
      `    violations++;`,
      `  }`,
      `}`,
      `process.exit(violations > 0 ? 2 : 0);`,
    ].join("\n");
    await writeFile(join(dir, "scripts", "check-states-marker.ts"), checkScript);

    // Run reconform WITHOUT --fix. GEN-001 should still auto-repair states.json
    // before the check-script runs, so STATE-001 should not fire.
    const r = await runCli(["reconform"], { cwd: dir, stdin: "" });
    expect(r.code).toBe(0);

    // states.json must now have __generated marker (written by GEN-001 auto-fix)
    const afterStates = await readFile(join(dir, "design-system", "atoms", "chip.states.json"), "utf8");
    const parsed = JSON.parse(afterStates);
    expect(parsed.__generated).toMatch(/@generated by claude-ds/);

    // No STATE-001 violations should appear in output
    expect(r.stdout).not.toMatch(/STATE-001/);
  });

  it("--backfill-meta: composite importing nothing gets CLASS-002 report-only (no auto-move without --demote-composites)", async () => {
    await scaffoldProject(dir);
    await writeFile(
      join(dir, "design-system", "composites", "plain.tsx"),
      `export function Plain() { return null; }\n`
    );

    const r = await runCli(["reconform", "--backfill-meta"], { cwd: dir });
    expect(r.code).toBe(0);
    // Report-only: should mention composite candidate
    expect(r.stdout).toMatch(/CLASS-002/);
    // But not CLASS-001 (no auto-move queued)
    expect(r.stdout).not.toMatch(/CLASS-001.*plain|plain.*CLASS-001/i);
  });
});
