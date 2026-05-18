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
    // Main component has meta; companions don't (they shouldn't need to)
    await writeFile(
      join(dir, "design-system", "atoms", "badge.tsx"),
      `export const meta = { kind: "atom", examples: [] };\nexport function Badge() { return null; }\n`
    );
    await writeFile(
      join(dir, "design-system", "atoms", "badge.showcase.tsx"),
      `export default function BadgeShowcase() { return null; }\n`
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
