import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { copyFileSync, mkdirSync } from "node:fs";

const SCRIPT = resolve("packs/next-react/files/scripts/generate-showcase-companion.ts");

const FIXTURE_ATOM = resolve("packs/next-react/tests/fixtures/showcase-companion-atom-meta");
const FIXTURE_CVA = resolve("packs/next-react/tests/fixtures/showcase-companion-cva");
const FIXTURE_MULTI_CVA_STUBBED = resolve("packs/next-react/tests/fixtures/showcase-companion-multi-cva-stubbed");
const FIXTURE_REF = resolve("packs/next-react/tests/fixtures/showcase-companion-reference");
const FIXTURE_DEFAULT_EXPORT = resolve("packs/next-react/tests/fixtures/showcase-companion-default-export");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "int-gen-showcase-companion-"));
}

/** Copy a fixture source file into a temp dir maintaining relative path. */
function copyFixture(fixtureSrc: string, dest: string, relPath: string): void {
  const destPath = join(dest, relPath);
  mkdirSync(join(dest, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
  copyFileSync(join(fixtureSrc, relPath), destPath);
}

describe("generate-showcase-companion.ts [integration]", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fresh();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ── atom with explicit examples ────────────────────────────────────────────

  // ── no-meta graceful skip ──────────────────────────────────────────────────

  it("skips components with no meta export and exits 0", async () => {
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    // Component without a meta export
    await writeFile(
      join(dsDir, "plain.tsx"),
      `import React from "react";\nexport function Plain() { return <div />; }\n`
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    // No showcase generated for it
    expect(existsSync(join(dsDir, "plain.showcase.tsx"))).toBe(false);
    // But GEN-000 warning emitted to stderr
    expect(r.stderr).toMatch(/GEN-000/);
  });

  // ── empty dir graceful ─────────────────────────────────────────────────────

  it("exits 0 when design-system dirs are absent", async () => {
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });

  // ── string-literal stripping (Bug 1) ──────────────────────────────────────

  it("CVA parser does not emit bogus Tailwind-modifier variant values (hover, active, etc.)", async () => {
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    // Component with Tailwind modifier strings inside CVA variant values
    await writeFile(
      join(dsDir, "button.tsx"),
      [
        `import React from "react";`,
        `import { cva } from "class-variance-authority";`,
        `const buttonVariants = cva("base", {`,
        `  variants: {`,
        `    intent: {`,
        `      primary: ["bg-primary text-primary-foreground", "hover:bg-primary/80", "active:bg-primary/70 active:translate-y-px", "aria-expanded:bg-primary/80"].join(" "),`,
        `      secondary: ["bg-secondary text-secondary-foreground", "hover:bg-border"].join(" "),`,
        `    },`,
        `    size: {`,
        `      sm: "h-7 gap-1 px-2.5 text-sm",`,
        `      default: "h-8 gap-1.5 px-3 text-sm",`,
        `    },`,
        `  },`,
        `  defaultVariants: { intent: "primary", size: "default" },`,
        `});`,
        `export function Button({ intent, size, ...props }: any) { return <button {...props} />; }`,
        `export const meta = { kind: "atom", examples: [{ name: "default", props: {} }], skip: [] };`,
      ].join("\n")
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const content = await readFile(join(dsDir, "button.showcase.tsx"), "utf8");
    // Must NOT contain bogus modifier-derived variant values
    expect(content).not.toContain('intent="hover"');
    expect(content).not.toContain('intent="active"');
    expect(content).not.toContain('intent="focus"');
    expect(content).not.toContain('intent="aria"');
    // Must contain exactly the 2 real intent groups and 2 real sizes
    expect(content).toContain(">Primary<");
    expect(content).toContain(">Secondary<");
  });

  // ── children fallback (Bug 2) ─────────────────────────────────────────────

  it("auto-generated non-icon combos get displayName as children", async () => {
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "btn.tsx"),
      [
        `import React from "react";`,
        `import { cva } from "class-variance-authority";`,
        `const v = cva("b", {`,
        `  variants: {`,
        `    intent: { primary: "p", secondary: "s" },`,
        `    size: { sm: "sm", icon: "ic" },`,
        `  },`,
        `  defaultVariants: { intent: "primary", size: "sm" },`,
        `});`,
        `export function Btn(props: any) { return <button {...props} />; }`,
        `export const meta = { kind: "atom", examples: [{ name: "default", props: {} }], skip: [] };`,
      ].join("\n")
    );

    spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });

    const content = await readFile(join(dsDir, "btn.showcase.tsx"), "utf8");
    // Non-icon size (sm) combos should have text children "Btn"
    expect(content).toContain(">Btn<");
    // Icon size combos should be self-closing (no children)
    expect(content).toContain('size="icon"');
    // Icon buttons should NOT have text children injected
    const iconComboIdx = content.indexOf('size="icon"');
    const afterIcon = content.slice(iconComboIdx, iconComboIdx + 80);
    expect(afterIcon).not.toContain(">Btn<");
  });

  // ── pretty label (Bug 3) ──────────────────────────────────────────────────

  it("grouped section headings use title-case, not underscore-joined debug keys", async () => {
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "badge.tsx"),
      [
        `import React from "react";`,
        `import { cva } from "class-variance-authority";`,
        `const v = cva("b", {`,
        `  variants: {`,
        `    tone: { primary: "p", danger: "d" },`,
        `    size: { sm: "s", lg: "l" },`,
        `  },`,
        `  defaultVariants: { tone: "primary", size: "sm" },`,
        `});`,
        `export function Badge(props: any) { return <span {...props} />; }`,
        `export const meta = { kind: "atom", examples: [{ name: "default", props: {} }], skip: [] };`,
      ].join("\n")
    );

    spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });

    const content = await readFile(join(dsDir, "badge.showcase.tsx"), "utf8");
    // Group headings must be title-cased primary values
    expect(content).toContain(">Primary<");
    expect(content).toContain(">Danger<");
    // Must NOT contain raw underscore combo keys as headings
    expect(content).not.toContain(">tone=primary_size=sm<");
    expect(content).not.toContain(">tone=danger_size=lg<");
  });

  // ── grouped CVA structure (Bug 4) ─────────────────────────────────────────

  it("CVA combos are grouped by first axis with secondary axis as row", async () => {
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "chip.tsx"),
      [
        `import React from "react";`,
        `import { cva } from "class-variance-authority";`,
        `const v = cva("c", {`,
        `  variants: {`,
        `    color: { red: "r", blue: "b" },`,
        `    size: { sm: "s", lg: "l" },`,
        `  },`,
        `  defaultVariants: { color: "red", size: "sm" },`,
        `});`,
        `export function Chip(props: any) { return <div {...props} />; }`,
        `export const meta = { kind: "atom", examples: [{ name: "default", props: {} }], skip: [] };`,
      ].join("\n")
    );

    spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });

    const content = await readFile(join(dsDir, "chip.showcase.tsx"), "utf8");
    // Should render a Variants section
    expect(content).toContain("Variants");
    // Each primary value gets its own section heading
    expect(content).toContain(">Red<");
    expect(content).toContain(">Blue<");
    // Buttons within each group are in a flex-wrap row
    expect(content).toContain("flex flex-wrap items-end gap-3");
  });

  // ── import style: named vs default export ────────────────────────────────

  it("named-export-only atom emits import { Name } from named import", async () => {
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    // Component with only a named export (no export default).
    // Uses a non-stub example (has a non-empty prop) so the import is emitted.
    await writeFile(
      join(dsDir, "app-shell.tsx"),
      [
        `import React from "react";`,
        `export function AppShell({ children }: { children?: React.ReactNode }) {`,
        `  return <div>{children}</div>;`,
        `}`,
        `export const meta = { kind: "atom", examples: [{ name: "with-child", props: { children: "hello" } }], skip: [] };`,
      ].join("\n")
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const content = await readFile(join(dsDir, "app-shell.showcase.tsx"), "utf8");
    // Must use named import because there is no default export
    expect(content).toContain('import { AppShell } from "./app-shell"');
    // Must NOT use default import
    expect(content).not.toMatch(/import AppShell from/);
  });

  it("default-export atom emits default import", async () => {
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    copyFixture(FIXTURE_DEFAULT_EXPORT, dir, "design-system/atoms/card.tsx");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const content = await readFile(join(dsDir, "card.showcase.tsx"), "utf8");
    // Must use default import because fixture has export default function Card
    expect(content).toContain('import Card from "./card"');
    // Must NOT use named import
    expect(content).not.toMatch(/import \{ Card \} from/);
  });

});

// ── ATOM fixture cluster (shared spawn) ─────────────────────────────────────

describe("generate-showcase-companion.ts [integration] — ATOM fixture cluster", () => {
  let dir: string;
  let content: string;

  beforeAll(async () => {
    dir = await fresh();
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    copyFixture(FIXTURE_ATOM, dir, "design-system/atoms/button.tsx");
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    content = await readFile(join(dsDir, "button.showcase.tsx"), "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits .showcase.tsx with @generated header for atom with explicit examples", () => {
    expect(content).toMatch(/^\/\/ @generated by claude-ds — do not edit\. Source: button\.tsx meta block\./);
    expect(content).toContain('import { Button } from "./button"');
    expect(content).toContain("default");
    expect(content).toContain("disabled");
    expect(content).toContain('label="Click me"');
  });

  it("generated .showcase.tsx does not contain @ts-nocheck", () => {
    expect(content).not.toContain("@ts-nocheck");
  });

  it("header in .showcase.tsx includes the source filename", () => {
    expect(content).toContain("Source: button.tsx meta block.");
  });
});

// ── CVA fixture cluster (shared spawn) ──────────────────────────────────────

describe("generate-showcase-companion.ts [integration] — CVA fixture cluster", () => {
  let dir: string;
  let content: string;

  beforeAll(async () => {
    dir = await fresh();
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    copyFixture(FIXTURE_CVA, dir, "design-system/atoms/badge.tsx");
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    content = await readFile(join(dsDir, "badge.showcase.tsx"), "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("auto-expands CVA cross-product and excludes skip[] entries", () => {
    expect(content).toContain("Sm");
    expect(content).toContain("Md");
    expect(content).toContain("Lg");
    expect(content).toContain("primary");
    expect(content).toContain("danger");
    const lgGroupIdx = content.indexOf(">Lg<");
    const nextGroupIdx = content.indexOf("<section", lgGroupIdx + 1);
    const lgSection = lgGroupIdx >= 0
      ? content.slice(lgGroupIdx, nextGroupIdx > lgGroupIdx ? nextGroupIdx : undefined)
      : "";
    expect(lgSection).not.toContain(">danger<");
  });

  it("CVA-expanded .showcase.tsx does not contain @ts-nocheck", () => {
    expect(content).not.toContain("@ts-nocheck");
  });
});

// ── REF fixture cluster (shared spawn) ──────────────────────────────────────

describe("generate-showcase-companion.ts [integration] — REF fixture cluster", () => {
  let dir: string;
  let content: string;

  beforeAll(async () => {
    dir = await fresh();
    const refDir = join(dir, "design-system", "references");
    await mkdir(refDir, { recursive: true });
    copyFixture(FIXTURE_REF, dir, "design-system/references/tokens-page.tsx");
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    content = await readFile(join(refDir, "tokens-page.showcase.tsx"), "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits reference showcase that calls meta.render()", () => {
    expect(content).toMatch(/^\/\/ @generated by claude-ds/);
    expect(content).toContain('import { meta } from "./tokens-page"');
    expect(content).toContain("meta.render()");
    expect(content).toContain("Design Tokens");
  });

  it("reference showcase wraps content in prose div", () => {
    expect(content).toContain('className="prose prose-neutral dark:prose-invert max-w-none"');
  });
});

// ── Integrity check tests (GEN-001 / GEN-002) ────────────────────────────────
// These test the reconform integrity logic by invoking reconform directly.
// We construct minimal consumer projects with .claude-ds.json, pack manifest,
// and pre-seeded generated files.

import { fileURLToPath } from "node:url";
const RECONFORM_SCRIPT = resolve("dist/cli.js");
const PACK_DIR = resolve("packs/next-react");

async function seedIntegrityFixture(dir: string, showcaseContent: string): Promise<void> {
  // .claude-ds.json
  await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ pack: "next-react", version: "v0.6.0", mode: "warn" }, null, 2));
  // Minimal design-system/contracts.md and tokens.json to avoid stub warning exit
  await mkdir(join(dir, "design-system", "atoms"), { recursive: true });
  await writeFile(join(dir, "design-system", "contracts.md"), "# Contracts\n" + "x\n".repeat(30));
  await writeFile(join(dir, "design-system", "tokens.json"), JSON.stringify({ color: { a: "#000" } }, null, 2) + "\n".repeat(30));
  // Component source with meta
  await writeFile(
    join(dir, "design-system", "atoms", "btn.tsx"),
    `import React from "react";\nexport function Btn() { return <button />; }\nexport const meta = { kind: "atom", examples: [{ name: "default", props: {} }], skip: [] };\n`
  );
  // Pre-seeded generated companion
  await writeFile(join(dir, "design-system", "atoms", "btn.showcase.tsx"), showcaseContent);
}

describe("reconform integrity check (GEN-001 / GEN-002)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fresh();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("GEN-001: flags missing @generated header in .showcase.tsx", async () => {
    // Showcase without header
    await seedIntegrityFixture(
      dir,
      `import React from "react";\nexport default function BtnShowcase() { return null; }\n`
    );

    const r = spawnSync("node", [RECONFORM_SCRIPT, "reconform"], {
      cwd: dir,
      encoding: "utf8",
      input: "\n", // auto-skip any prompts
    });

    // Must mention GEN-001
    const combined = r.stdout + r.stderr;
    expect(combined).toMatch(/GEN-001/);
  });

  it("GEN-002: flags drift when .showcase.tsx was hand-edited", async () => {
    // Correct header but content differs from what generator would produce
    const showcaseDrifted = `// @generated by claude-ds — do not edit. Source: btn.tsx meta block.\nimport React from "react";\nimport Btn from "./btn";\n\nexport default function BtnShowcase() {\n  // HAND EDIT: this line was added\n  return <div>CUSTOM</div>;\n}\n`;
    await seedIntegrityFixture(dir, showcaseDrifted);

    const r = spawnSync("node", [RECONFORM_SCRIPT, "reconform"], {
      cwd: dir,
      encoding: "utf8",
      input: "\n",
    });

    const combined = r.stdout + r.stderr;
    expect(combined).toMatch(/GEN-002/);
  });

  it("--fix: GEN-002 regenerates showcase to match generator output", async () => {
    const showcaseDrifted = `// @generated by claude-ds — do not edit. Source: btn.tsx meta block.\nimport React from "react";\nexport default function BtnShowcase() { return <div>DRIFTED</div>; }\n`;
    await seedIntegrityFixture(dir, showcaseDrifted);

    spawnSync("node", [RECONFORM_SCRIPT, "reconform", "--fix"], {
      cwd: dir,
      encoding: "utf8",
      input: "\n",
    });

    // After --fix, the showcase must be regenerated (no longer contain DRIFTED)
    const repaired = await readFile(join(dir, "design-system", "atoms", "btn.showcase.tsx"), "utf8");
    expect(repaired).not.toContain("DRIFTED");
    expect(repaired).toMatch(/^\/\/ @generated by claude-ds/);
  });

  it("clean project: no GEN violations when companions match regeneration", async () => {
    // Generate companions using the companion script, then verify reconform is clean
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ pack: "next-react", version: "v0.6.0", mode: "warn" }, null, 2));
    await writeFile(join(dir, "design-system", "contracts.md"), "# Contracts\n" + "x\n".repeat(30));
    await writeFile(join(dir, "design-system", "tokens.json"), JSON.stringify({ color: { a: "#000" } }, null, 2) + "\n".repeat(30));
    await writeFile(
      join(dsDir, "btn.tsx"),
      `import React from "react";\nexport function Btn() { return <button />; }\nexport const meta = { kind: "atom", examples: [{ name: "default", props: {} }], skip: [] };\n`
    );

    // Generate companions first
    spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });

    // Now run reconform — should report no GEN violations
    const r = spawnSync("node", [RECONFORM_SCRIPT, "reconform"], {
      cwd: dir,
      encoding: "utf8",
      input: "\n",
    });

    const combined = r.stdout + r.stderr;
    expect(combined).toContain("integrity check: all generated files are clean");
    expect(combined).not.toMatch(/GEN-001/);
    expect(combined).not.toMatch(/GEN-002/);
  });
});

// ── Error boundary + stub-meta tests ────────────────────────────────────────

describe("error boundary and stub-meta placeholder", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fresh();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ── Task 1: error boundary import is emitted in page.tsx ──────────────────

  it("page.tsx imports ShowcaseBoundary from _showcase-boundary", async () => {
    const pagePath = resolve("packs/next-react/files/app/design/[...slug]/page.tsx");
    const content = await readFile(pagePath, "utf8");
    expect(content).toContain('import { ShowcaseBoundary }');
    expect(content).toContain('_showcase-boundary');
  });

  it("page.tsx wraps <Showcase /> in <ShowcaseBoundary>", async () => {
    const pagePath = resolve("packs/next-react/files/app/design/[...slug]/page.tsx");
    const content = await readFile(pagePath, "utf8");
    expect(content).toContain('<ShowcaseBoundary');
    expect(content).toContain('<Showcase />');
    // Boundary must appear before Showcase (wraps it)
    expect(content.indexOf('<ShowcaseBoundary')).toBeLessThan(content.indexOf('<Showcase />'));
  });

  // ── Task 2: stub-meta produces placeholder card ───────────────────────────

  it("stub meta (name=default, empty props, no CVA) emits placeholder — no component import", async () => {
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "stub-atom.tsx"),
      [
        `import React from "react";`,
        `export function StubAtom({ items }: { items: string[] }) { return <ul>{items.map(i => <li key={i}>{i}</li>)}</ul>; }`,
        `export const meta = { kind: "atom", examples: [{ name: "default", props: {} }], skip: [] };`,
      ].join("\n")
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const content = await readFile(join(dsDir, "stub-atom.showcase.tsx"), "utf8");
    // Must have @generated header
    expect(content).toMatch(/^\/\/ @generated by claude-ds/);
    // Must contain placeholder text
    expect(content).toContain("No examples defined");
    expect(content).toContain("meta.examples");
    // Must NOT import or render the component
    expect(content).not.toContain('import { StubAtom }');
    expect(content).not.toContain('import StubAtom');
    expect(content).not.toContain('<StubAtom');
  });

  // ── Task 2: non-stub meta still renders component ─────────────────────────

  it("non-stub meta (non-empty props) renders component normally", async () => {
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "real-atom.tsx"),
      [
        `import React from "react";`,
        `export function RealAtom({ label }: { label: string }) { return <span>{label}</span>; }`,
        `export const meta = { kind: "atom", examples: [{ name: "filled", props: { label: "hello" } }], skip: [] };`,
      ].join("\n")
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const content = await readFile(join(dsDir, "real-atom.showcase.tsx"), "utf8");
    // Must render the component
    expect(content).toContain('import { RealAtom }');
    expect(content).toContain('<RealAtom');
    // Must NOT show placeholder
    expect(content).not.toContain("No examples defined");
  });

  it("stub meta with CVA variants renders normally (not placeholder)", async () => {
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "cva-atom.tsx"),
      [
        `import React from "react";`,
        `import { cva } from "class-variance-authority";`,
        `const v = cva("b", {`,
        `  variants: { intent: { primary: "p", secondary: "s" } },`,
        `  defaultVariants: { intent: "primary" },`,
        `});`,
        `export function CvaAtom(props: any) { return <div {...props} />; }`,
        // stub meta but CVA exists — should render normally
        `export const meta = { kind: "atom", examples: [{ name: "default", props: {} }], skip: [] };`,
      ].join("\n")
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const content = await readFile(join(dsDir, "cva-atom.showcase.tsx"), "utf8");
    // Should render component (CVA expanded combos)
    expect(content).toContain('import { CvaAtom }');
    expect(content).toContain('<CvaAtom');
    // Must NOT show placeholder
    expect(content).not.toContain("No examples defined");
  });

  // ── multi-CVA file with examples:[] emits placeholder (regression for #62) ──

  it("multi-CVA file with examples:[] emits placeholder card, not malformed JSX", async () => {
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    copyFixture(FIXTURE_MULTI_CVA_STUBBED, dir, "design-system/atoms/badge.tsx");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const content = await readFile(join(dsDir, "badge.showcase.tsx"), "utf8");
    // Must have @generated header
    expect(content).toMatch(/^\/\/ @generated by claude-ds/);
    // Must contain placeholder card marker
    expect(content).toContain("No examples defined");
    expect(content).toContain("meta.examples");
    // Must NOT contain CVA-expanded variants= attributes (would be malformed JSX)
    expect(content).not.toContain("variants=");
    // Must NOT render the component as JSX
    expect(content).not.toContain("<Badge");
  });
});

// ── v0.7.0 hand-off contract: full-variant matrix + states + analyzer hook ──

/** Set up a Crewops-shaped fixture: one CVA atom with states + optional analyzer. */
async function seedCrewopsFixture(dir: string, opts: { withAnalyzer: boolean }): Promise<string> {
  const dsDir = join(dir, "design-system", "atoms");
  await mkdir(dsDir, { recursive: true });
  await writeFile(
    join(dsDir, "button.tsx"),
    [
      `import React from "react";`,
      `import { cva } from "class-variance-authority";`,
      `const v = cva("b", {`,
      `  variants: {`,
      `    intent: { primary: "p", secondary: "s", destructive: "d" },`,
      `    size: { sm: "s", md: "m", lg: "l" },`,
      `  },`,
      `  defaultVariants: { intent: "primary", size: "md" },`,
      `});`,
      `export function Button(props: any) { return <button {...props} />; }`,
      `export const meta = {`,
      `  kind: "atom",`,
      `  examples: [{ name: "default", props: { children: "Click" } }],`,
      `  skip: [],`,
      `};`,
    ].join("\n")
  );
  if (opts.withAnalyzer) {
    const scriptsDir = join(dir, "scripts");
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(
      join(scriptsDir, "analyze-component-usage.ts"),
      [
        `export default async function analyze(_files: string[]) {`,
        `  const m = new Map();`,
        `  const literal = new Map();`,
        `  const intent = new Map();`,
        `  intent.set("primary", 3);`,
        `  literal.set("intent", intent);`,
        `  m.set("Button", { literal, dynamicProps: new Set(["size"]) });`,
        `  return m;`,
        `}`,
      ].join("\n")
    );
    const appDir = join(dir, "app");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "page.tsx"), `export default function P() { return null; }\n`);
  }
  return join(dsDir, "button.showcase.tsx");
}

describe("v0.7.0 hand-off contract (issue #60) — no-analyzer cluster", () => {
  let dir: string;
  let showcaseContent: string;

  beforeAll(async () => {
    dir = await fresh();
    const showcasePath = await seedCrewopsFixture(dir, { withAnalyzer: false });
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    showcaseContent = await readFile(showcasePath, "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("(a) generated showcase has no @ts-nocheck", () => {
    expect(showcaseContent).not.toContain("@ts-nocheck");
  });

  it("(b) full CVA variant matrix rendered (3 intents × 3 sizes = 9 combos)", () => {
    expect(showcaseContent).toContain(">Primary<");
    expect(showcaseContent).toContain(">Secondary<");
    expect(showcaseContent).toContain(">Destructive<");
  });

  it("(d-neg) without analyzer file, no tag glyphs are emitted", () => {
    expect(showcaseContent).not.toContain("✓");
    expect(showcaseContent).not.toContain("⚠");
    expect(showcaseContent).not.toContain("✗");
  });
});

describe("v0.7.0 hand-off contract (issue #60) — bespoke", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fresh();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("(d) with stub analyzer present, tag column appears in output", async () => {
    const showcasePath = await seedCrewopsFixture(dir, { withAnalyzer: true });
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const content = await readFile(showcasePath, "utf8");
    const hasTag = content.includes("✓") || content.includes("⚠") || content.includes("✗");
    expect(hasTag).toBe(true);
  });
});

// ── v0.7.8 showcase format finalization (issue #65) ──────────────────────────

/** Seed an atom whose CVA matches a name from explicit examples (overlap intent). */
async function seedButtonWithIconAndStates(dir: string, opts: { withAnalyzer: boolean }): Promise<string> {
  const dsDir = join(dir, "design-system", "atoms");
  await mkdir(dsDir, { recursive: true });
  await writeFile(
    join(dsDir, "button.tsx"),
    [
      `import React from "react";`,
      `import { cva } from "class-variance-authority";`,
      `const v = cva("b", {`,
      `  variants: {`,
      `    intent: { primary: "p", secondary: "s" },`,
      `    size: { sm: "sm", md: "md", icon: "ic", "icon-sm": "ics" },`,
      `  },`,
      `  defaultVariants: { intent: "primary", size: "md" },`,
      `});`,
      `export function Button(props: any) { return <button {...props} />; }`,
      `export const meta = {`,
      `  kind: "atom",`,
      `  examples: [{ name: "intent=primary_size=md", props: { children: "Click" } }],`,
      `  skip: [],`,
      `};`,
    ].join("\n")
  );
  if (opts.withAnalyzer) {
    const scriptsDir = join(dir, "scripts");
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(
      join(scriptsDir, "analyze-component-usage.ts"),
      [
        `export default async function analyze(_files: string[]) {`,
        `  const m = new Map();`,
        `  const literal = new Map();`,
        `  const intent = new Map();`,
        `  intent.set("primary", 8);`,
        `  intent.set("ghost", 2);`,
        `  literal.set("intent", intent);`,
        `  m.set("Button", { literal, dynamicProps: new Set() });`,
        `  return m;`,
        `}`,
      ].join("\n")
    );
    const appDir = join(dir, "app");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "page.tsx"), `export default function P() { return null; }\n`);
  }
  return join(dsDir, "button.showcase.tsx");
}

describe("v0.7.8 showcase format finalization (issue #65) — no-analyzer cluster", () => {
  let dir: string;
  let content: string;

  beforeAll(async () => {
    dir = await fresh();
    const showcasePath = await seedButtonWithIconAndStates(dir, { withAnalyzer: false });
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    content = await readFile(showcasePath, "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("(#1) Variants grid renders the full CVA matrix even when names overlap with Examples", () => {
    const variantsIdx = content.indexOf(">Variants<");
    expect(variantsIdx).toBeGreaterThan(-1);
    const variantsBlock = content.slice(variantsIdx);
    expect(variantsBlock).toContain('intent="primary" size="md"');
    expect(variantsBlock).toContain('intent="secondary" size="md"');
  });

  it("(#2) icon* size cells inject the lucide Square placeholder", () => {
    expect(content).toContain('import { Square } from "lucide-react";');
    expect(content).toMatch(/size="icon"[\s\S]*?<Square/);
    expect(content).toMatch(/size="icon-sm"[\s\S]*?<Square/);
  });

});

describe("v0.7.8 showcase format finalization (issue #65) — with-analyzer cluster", () => {
  let dir: string;
  let content: string;

  beforeAll(async () => {
    dir = await fresh();
    const showcasePath = await seedButtonWithIconAndStates(dir, { withAnalyzer: true });
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    content = await readFile(showcasePath, "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("(#3) per-cell ✓/⚠/✗ tags are dropped from the Variants grid", () => {
    const variantsIdx = content.indexOf(">Variants<");
    const usageIdx = content.indexOf(">Usage<");
    expect(variantsIdx).toBeGreaterThan(-1);
    expect(usageIdx).toBeGreaterThan(-1);
    const variantsBlock = content.slice(variantsIdx);
    expect(variantsBlock).not.toContain("✓");
    expect(variantsBlock).not.toContain("✗");
    expect(variantsBlock).not.toContain("⚠");
    expect(usageIdx).toBeLessThan(variantsIdx);
  });

  it("(#3) Usage block renders ✓ Used (in CVA) and ✗ Unknown (not in CVA) rows", () => {
    expect(content).toContain(">Usage<");
    expect(content).toMatch(/✓[\s\S]*?Used[\s\S]*?intent="primary" \(8\)/);
    expect(content).toMatch(/✗[\s\S]*?Unknown at callsites[\s\S]*?intent="ghost" \(2\)/);
    expect(content).not.toContain("⚠");
  });
});

// ── AST-based meta extractor integration tests (issue #61 cycle 2) ───────────

const FIXTURE_AST_EXTRACTOR = resolve("packs/next-react/tests/fixtures/ast-extractor-fixture");

const FIXTURE_CARRIES_REFS = resolve(
  "packs/next-react/tests/fixtures/showcase-companion-carries-refs"
);
const FIXTURE_TYPE_IMPORT_CARRY = resolve(
  "packs/next-react/tests/fixtures/showcase-companion-type-import-carry"
);
const FIXTURE_TYPED_LOCAL_INLINE = resolve(
  "packs/next-react/tests/fixtures/showcase-companion-typed-local-inline"
);
const FIXTURE_ALIAS_FIXTURES = resolve(
  "packs/next-react/tests/fixtures/showcase-companion-alias-fixtures"
);

describe("AST-based meta extractor (A3) — data-grid fixture", () => {
  let dir: string;
  let showcaseContent: string;

  beforeAll(async () => {
    dir = await fresh();
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    copyFixture(FIXTURE_AST_EXTRACTOR, dir, "design-system/atoms/data-grid.tsx");
    copyFixture(FIXTURE_AST_EXTRACTOR, dir, "design-system/atoms/grid-fixtures.ts");
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    showcaseContent = await readFile(join(dsDir, "data-grid.showcase.tsx"), "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits arrow function source verbatim in column.cell props", () => {
    expect(showcaseContent).toMatch(/^\/\/ @generated by claude-ds/);
    expect(showcaseContent).toContain("(row: GridRow) => row.name");
    expect(showcaseContent).toContain("(row: GridRow) => row.id");
  });

  it("inlines imported sibling fixture values (sampleRows)", () => {
    expect(showcaseContent).toContain('"r1"');
    expect(showcaseContent).toContain("Alpha");
    expect(showcaseContent).toContain('"r2"');
    expect(showcaseContent).toContain('"r3"');
  });

  it("does not emit 'No examples defined' when functions are present in props", () => {
    expect(showcaseContent).not.toContain("No examples defined");
    expect(showcaseContent).toContain("default");
    expect(showcaseContent).toContain("loading");
    expect(showcaseContent).toContain("with-transform");
  });
});

describe("AST-based meta extractor (A3) — data-table carries-refs fixture", () => {
  let dir: string;
  let content: string;

  beforeAll(async () => {
    dir = await fresh();
    copyFixture(FIXTURE_CARRIES_REFS, dir, "design-system/composites/data-table.tsx");
    copyFixture(FIXTURE_CARRIES_REFS, dir, "design-system/_fixtures/job-fixtures.ts");
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    content = await readFile(join(dir, "design-system/composites/data-table.showcase.tsx"), "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("mirrors 'use client' from the source onto the generated showcase", () => {
    expect(content.startsWith('"use client";')).toBe(true);
  });

  it("carries import for value identifiers referenced inside inlined arrow bodies", () => {
    expect(content).toContain("JOB_STATUS_LABEL");
    expect(content).toMatch(
      /import\s*\{[^}]*JOB_STATUS_LABEL[^}]*\}\s*from\s*"\.\.\/_fixtures\/job-fixtures"/
    );
  });

  it("emits a const declaration for source-local identifiers referenced in unevaluated expressions (jobColumns.map)", () => {
    expect(content).toMatch(/const\s+jobColumns\b/);
    expect(content).toContain("jobColumns.map");
  });

  it("re-emits `import type` for types declared in the source component module", () => {
    expect(content).toMatch(
      /import\s+type\s*\{[^}]*DataTableColumn[^}]*\}\s*from\s*"\.\/data-table"/
    );
  });
});

describe("AST-based meta extractor (A3) — alias fixtures (#93) cluster", () => {
  let dir: string;
  let content: string;

  beforeAll(async () => {
    dir = await fresh();
    copyFixture(FIXTURE_ALIAS_FIXTURES, dir, "design-system/composites/contact-card.tsx");
    copyFixture(FIXTURE_ALIAS_FIXTURES, dir, "design-system/_fixtures/contact-fixtures.ts");
    copyFixture(FIXTURE_ALIAS_FIXTURES, dir, "design-system/_fixtures/address-fixtures.ts");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-consumer" }));
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }));
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    content = await readFile(join(dir, "design-system/composites/contact-card.showcase.tsx"), "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("#93: direct @/ alias import produces alias-form specifier in carried import", () => {
    expect(content).toMatch(
      /import\s*\{[^}]*formatContact[^}]*\}\s*from\s*"@\/design-system\/_fixtures\/contact-fixtures"/
    );
    expect(content).not.toContain('from "../_fixtures/contact-fixtures"');
    expect(content).not.toContain('from "./contact-fixtures"');
  });

  it("#93: transitive fixture import produces alias-form specifier (not fixture-relative path)", () => {
    expect(content).toMatch(
      /import\s*\{[^}]*sampleAddress[^}]*\}\s*from\s*"@\/design-system\/_fixtures\/address-fixtures"/
    );
    expect(content).not.toContain('from "./address-fixtures"');
  });
});

describe("AST-based meta extractor (A3) — bespoke", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fresh();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("re-emits `import type` for type-only imports referenced in example callbacks", async () => {
    copyFixture(FIXTURE_TYPE_IMPORT_CARRY, dir, "design-system/atoms/filter-button.tsx");
    copyFixture(FIXTURE_TYPE_IMPORT_CARRY, dir, "design-system/_fixtures/handler-types.ts");

    spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });

    const content = await readFile(
      join(dir, "design-system/atoms/filter-button.showcase.tsx"),
      "utf8"
    );
    expect(content).toMatch(/import\s+type\s*\{[^}]*Foo[^}]*\}\s*from/);
    expect(content).toContain(": Foo");
  });

  it("inlines typed local const with annotation preserved and carries transitive type-import", async () => {
    copyFixture(FIXTURE_TYPED_LOCAL_INLINE, dir, "design-system/composites/item-list.tsx");
    copyFixture(FIXTURE_TYPED_LOCAL_INLINE, dir, "design-system/_fixtures/item-types.ts");

    spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });

    const content = await readFile(
      join(dir, "design-system/composites/item-list.showcase.tsx"),
      "utf8"
    );
    expect(content).toMatch(/const\s+itemColumns\s*:/);
    expect(content).toContain("itemColumns");
    expect(content).toMatch(/import\s+type\s*\{[^}]*Item[^}]*\}\s*from/);
  });

  it("over-eager identifier collection: property-access on fixture export with internal helper does not pull in helper or transitive imports", async () => {
    // Regression for: meta uses `hendersonContact.fullName` (string property access).
    // contact-fixtures.ts defines an internal helper function `buildContact()` and imports
    // `hendersonAddress` from address-fixtures.ts to build the fixture objects.
    // The showcase must only import the directly referenced identifiers (hendersonContact,
    // okaforLead, longNameContact) and NOT the internal helper or transitive imports.
    const dsDir = join(dir, "design-system", "composites");
    const fixturesDir = join(dir, "design-system", "_fixtures");
    await mkdir(dsDir, { recursive: true });
    await mkdir(fixturesDir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-consumer" }));
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }));

    // Internal address fixture (transitively imported by contact-fixtures)
    await writeFile(
      join(fixturesDir, "address-fixtures.ts"),
      [
        `export const hendersonAddress = { street: "1 Henderson Ave" };`,
        `export const longAddress = { street: "A Very Long Street Name Indeed" };`,
      ].join("\n")
    );

    // Contact fixtures — internal helper `buildContact` is NOT exported.
    // hendersonContact et al. are built via the helper call (CallExpression).
    await writeFile(
      join(fixturesDir, "contact-fixtures.ts"),
      [
        `import { hendersonAddress, longAddress } from "./address-fixtures";`,
        `function buildContact(name: string, phone: string, addr: { street: string }) {`,
        `  return { fullName: name, phoneE164: phone, addressStreet: addr.street };`,
        `}`,
        `export const hendersonContact = buildContact("Jane Henderson", "+15551234567", hendersonAddress);`,
        `export const okaforLead = buildContact("Chidi Okafor", "+15559876543", longAddress);`,
        `export const longNameContact = buildContact("Maximilian Bartholomew", "+15550001234", hendersonAddress);`,
      ].join("\n")
    );

    // Component meta — only uses .fullName and .phoneE164 (string properties)
    await writeFile(
      join(dsDir, "contact-card.tsx"),
      [
        `import {`,
        `  hendersonContact,`,
        `  okaforLead,`,
        `  longNameContact,`,
        `} from "@/design-system/_fixtures/contact-fixtures";`,
        ``,
        `export const meta = {`,
        `  kind: "composite" as const,`,
        `  examples: [`,
        `    { name: "Henderson", props: { name: hendersonContact.fullName, phone: hendersonContact.phoneE164 } },`,
        `    { name: "Okafor", props: { name: okaforLead.fullName } },`,
        `  ],`,
        `  states: {`,
        `    longText: { props: { name: longNameContact.fullName } },`,
        `  },`,
        `};`,
        ``,
        `export default function ContactCard({ name, phone }: { name: string; phone?: string }) {`,
        `  return <div>{name}{phone && <span>{phone}</span>}</div>;`,
        `}`,
      ].join("\n")
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);

    const content = await readFile(join(dsDir, "contact-card.showcase.tsx"), "utf8");

    // The meta props fully resolve to string values, so the showcase must not
    // import the fixture helpers at all — just emit the plain strings inline.
    // (Or if the property-access falls back to a FnMarker, hendersonContact et al.
    // are the only identifiers that should be imported — not internal helpers.)

    // Fixture-internal helper must NOT appear in the showcase
    expect(content).not.toContain("buildContact");

    // Transitive fixture imports must NOT appear in the showcase
    expect(content).not.toContain("hendersonAddress");
    expect(content).not.toContain("longAddress");
    expect(content).not.toContain("address-fixtures");
  });
});

// ── JSX-attribute / auto-children regression tests (#66, #67, #68, #73) ──────

describe("JSX attribute / children emission regressions", () => {
  // All 7 fixtures share a single generator spawn — distinct file paths means
  // each test reads an independent output. Saves 6 spawns vs one-per-test.
  let dir: string;
  let atomsDir: string;
  let compositesDir: string;

  beforeAll(async () => {
    dir = await fresh();
    atomsDir = join(dir, "design-system", "atoms");
    compositesDir = join(dir, "design-system", "composites");
    await mkdir(atomsDir, { recursive: true });
    await mkdir(compositesDir, { recursive: true });

    // #66 — boolean CVA axis
    await writeFile(
      join(atomsDir, "tag.tsx"),
      [
        `import React from "react";`,
        `import { cva } from "class-variance-authority";`,
        `const v = cva("t", {`,
        `  variants: {`,
        `    tone: { neutral: "n", primary: "p" },`,
        `    selected: { true: "sel", false: "unsel" },`,
        `  },`,
        `  defaultVariants: { tone: "neutral", selected: false },`,
        `});`,
        `export function Tag(props: { tone?: "neutral" | "primary"; selected?: boolean; children?: React.ReactNode }) { return <span {...props} />; }`,
        `export const meta = { kind: "atom", examples: [{ name: "default", props: {} }], skip: [] };`,
      ].join("\n")
    );

    // #67 — boolean-shaped aria attr in CVA
    await writeFile(
      join(atomsDir, "input-x.tsx"),
      [
        `import React from "react";`,
        `import { cva } from "class-variance-authority";`,
        `const v = cva("i", {`,
        `  variants: {`,
        `    size: { sm: "s", md: "m" },`,
        `    "aria-invalid": { true: "inv", false: "ok" },`,
        `  },`,
        `  defaultVariants: { size: "md", "aria-invalid": false },`,
        `});`,
        `export function InputX(props: any) { return <input {...props} />; }`,
        `export const meta = { kind: "atom", examples: [{ name: "default", props: {} }], skip: [] };`,
      ].join("\n")
    );

    // #68 — childless component renders self-closing
    await writeFile(
      join(atomsDir, "brand-mark.tsx"),
      [
        `import React from "react";`,
        `import { cva } from "class-variance-authority";`,
        `const v = cva("b", {`,
        `  variants: {`,
        `    size: { sm: "s", md: "m" },`,
        `  },`,
        `  defaultVariants: { size: "md" },`,
        `});`,
        `export function BrandMark({ size }: { size?: "sm" | "md" }) { return <svg data-size={size} />; }`,
        `export const meta = { kind: "atom", examples: [{ name: "default", props: {} }], skip: [] };`,
      ].join("\n")
    );

    // #73 — embedded escaped quotes
    await writeFile(
      join(atomsDir, "echo.tsx"),
      [
        `import React from "react";`,
        `export function Echo(props: { phrase?: string }) { return <span>{props.phrase}</span>; }`,
        `export const meta = { kind: "atom", examples: [{ name: "with-quotes", props: { phrase: "say \\"hi\\"" } }], skip: [] };`,
      ].join("\n")
    );

    // #71 — property access on module-scope const
    await writeFile(
      join(atomsDir, "phone.tsx"),
      [
        `import React from "react";`,
        `const contact = { phoneE164: "+15551234567", name: "Acme" };`,
        `export function Phone({ phoneNumber }: { phoneNumber: string }) { return <a>{phoneNumber}</a>; }`,
        `export const meta = {`,
        `  kind: "atom",`,
        `  examples: [{ name: "default", props: { phoneNumber: contact.phoneE164 } }],`,
        `  skip: [],`,
        `};`,
      ].join("\n")
    );

    // #72 — new Date(...) verbatim
    await writeFile(
      join(atomsDir, "stamp.tsx"),
      [
        `import React from "react";`,
        `export function Stamp({ created }: { created: Date }) { return <time>{created.toISOString()}</time>; }`,
        `export const meta = {`,
        `  kind: "atom",`,
        `  examples: [{ name: "default", props: { created: new Date("2026-01-01") } }],`,
        `  skip: [],`,
        `};`,
      ].join("\n")
    );

    // #72 — array-index expression
    await writeFile(
      join(compositesDir, "notify.tsx"),
      [
        `import React from "react";`,
        `const acmeNotifications = [`,
        `  { id: "n1", title: "First notification" },`,
        `  { id: "n2", title: "Second notification" },`,
        `];`,
        `export function Notify({ notification }: { notification: { id: string; title: string } }) {`,
        `  return <div>{notification.title}</div>;`,
        `}`,
        `export const meta = {`,
        `  kind: "composite",`,
        `  examples: [{ name: "default", props: { notification: acmeNotifications[0] } }],`,
        `  skip: [],`,
        `};`,
      ].join("\n")
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("#66 boolean CVA axis emits JSX expression form, not string", async () => {
    const content = await readFile(join(atomsDir, "tag.showcase.tsx"), "utf8");
    expect(content).toContain("selected={true}");
    expect(content).toContain("selected={false}");
    expect(content).not.toContain('selected="true"');
    expect(content).not.toContain('selected="false"');
  });

  it("#67 boolean-shaped aria-invalid axis emits JSX expression", async () => {
    const content = await readFile(join(atomsDir, "input-x.showcase.tsx"), "utf8");
    expect(content).toContain("aria-invalid={true}");
    expect(content).toContain("aria-invalid={false}");
    expect(content).not.toContain('aria-invalid="true"');
    expect(content).not.toContain('aria-invalid="false"');
  });

  it("#68 component without children prop renders self-closing", async () => {
    const content = await readFile(join(atomsDir, "brand-mark.showcase.tsx"), "utf8");
    expect(content).not.toContain(">BrandMark</BrandMark>");
    expect(content).toMatch(/<BrandMark\s+size="sm"\s*\/>/);
  });

  it("#73 embedded escaped quotes in meta string emit valid JSX attribute", async () => {
    const content = await readFile(join(atomsDir, "echo.showcase.tsx"), "utf8");
    expect(content).not.toContain('phrase="\\"hi\\""');
    expect(content).not.toContain('phrase="\\"');
    const hasExprForm = /phrase=\{"say \\"hi\\""\}/.test(content);
    const hasEntityForm = content.includes('phrase="say &quot;hi&quot;"');
    expect(hasExprForm || hasEntityForm).toBe(true);
  });

  it("#71 resolves property access on module-scope const literal", async () => {
    const content = await readFile(join(atomsDir, "phone.showcase.tsx"), "utf8");
    expect(content).not.toContain("phoneNumber={null}");
    expect(content).toContain('phoneNumber="+15551234567"');
  });

  it("#72 emits new Date(...) verbatim in showcase JSX", async () => {
    const content = await readFile(join(atomsDir, "stamp.showcase.tsx"), "utf8");
    expect(content).not.toContain("created={null}");
    expect(content).toContain(`new Date("2026-01-01")`);
  });

  it("#72 resolves array-index expression against module-scope const", async () => {
    const content = await readFile(join(compositesDir, "notify.showcase.tsx"), "utf8");
    expect(content).not.toContain("notification={null}");
    const hasResolved = /notification=\{\s*\{[^}]*id:\s*"n1"/.test(content);
    const hasVerbatim = content.includes("acmeNotifications[0]");
    expect(hasResolved || hasVerbatim).toBe(true);
  });
});

// ── #69 namespace export + #70 sibling function declarations ────────────────

describe("namespace export + sibling function declarations (#69, #70)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fresh();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ── #69 — namespace-only export must fail loud, not silently emit broken JSX ─
  it("#69 namespace-only export (object literal) fails loud with actionable error", async () => {
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "skeleton.tsx"),
      [
        `import React from "react";`,
        `function Line(props: any) { return <span {...props} />; }`,
        `function Block(props: any) { return <div {...props} />; }`,
        `function Circle(props: any) { return <span {...props} />; }`,
        `export const Skeleton = { Line, Block, Circle };`,
        `export const meta = { kind: "atom", examples: [{ name: "line", props: {} }], skip: [] };`,
      ].join("\n")
    );
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    // Must exit non-zero
    expect(r.status).not.toBe(0);
    // Error must mention the file and the problem
    const combined = r.stdout + r.stderr;
    expect(combined).toMatch(/skeleton\.tsx/);
    expect(combined).toMatch(/namespace|not callable|object literal/i);
  });

  // ── #70 — sibling function declarations get imports emitted when referenced in meta JSX ─
  it("#70 sibling function declaration referenced in meta JSX gets imported", async () => {
    const dsDir = join(dir, "design-system", "composites");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "card.tsx"),
      [
        `import React from "react";`,
        `export function Card({ children }: { children?: React.ReactNode }) {`,
        `  return <div>{children}</div>;`,
        `}`,
        `export function CardHeader({ children }: { children?: React.ReactNode }) {`,
        `  return <div>{children}</div>;`,
        `}`,
        `export function CardBody({ children }: { children?: React.ReactNode }) {`,
        `  return <div>{children}</div>;`,
        `}`,
        `export const meta = {`,
        `  kind: "composite",`,
        `  examples: [{`,
        `    name: "with-header",`,
        `    props: { children: <><CardHeader>Title</CardHeader><CardBody>Body</CardBody></> }`,
        `  }],`,
        `  skip: [],`,
        `};`,
      ].join("\n")
    );
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const content = await readFile(join(dsDir, "card.showcase.tsx"), "utf8");
    // The generated showcase must import CardHeader and CardBody from "./card"
    expect(content).toMatch(/import\s*\{[^}]*CardHeader[^}]*\}\s*from\s*"\.\/card"/);
    expect(content).toMatch(/import\s*\{[^}]*CardBody[^}]*\}\s*from\s*"\.\/card"/);
    // Card itself must still be imported once (no duplicate)
    const cardImportMatches = content.match(/import\s*(?:\{[^}]*\bCard\b[^}]*\}|Card)\s*from\s*"\.\/card"/g) ?? [];
    // Card should appear in an import statement (either alone or grouped with siblings).
    expect(cardImportMatches.length).toBeGreaterThan(0);
    // No two separate `import { Card } from "./card"` lines.
    const cardOnlyImports = content.match(/^import\s*\{\s*Card\s*\}\s*from\s*"\.\/card"/gm) ?? [];
    expect(cardOnlyImports.length).toBeLessThanOrEqual(1);
  });
});

// ── Bug B: carried locals emitted in discovery order (dependent before dependency) ──
// When a local const `b` references another local const `a`, and `b` is
// discovered first (because meta.examples directly uses `b`), the generator
// previously emitted `const b = …; const a = …;` — causing TS2448 "used before
// declaration" because `b`'s initializer references `a`. The fix topologically
// sorts carried locals so dependencies always precede dependents.

describe("Bug B — carried locals are emitted in dependency order (no TS2448)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fresh();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("dependency local (a) is emitted before dependent local (b) that references it", async () => {
    // Reproduce the scenario: `c` references `b` which references `a`.
    // meta.examples uses `c` directly. Discovery order adds `b` to carried first
    // (because it's in `c`'s source), then `a` (because it's in `b`'s source).
    // Without topological sort the output would be `const b = …; const a = …;`
    // causing TS2448 since `b` references `a` before `a` is declared.
    const dsDir = join(dir, "design-system", "atoms");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "chain.tsx"),
      [
        `import React from "react";`,
        `export function Foo() { return <div />; }`,
        `const a = <Foo />;`,
        `const b = <>{a}<Foo /></>;`,
        `const c = <>{b}<Foo /></>;`,
        `export function Chain({ children }: { children?: React.ReactNode }) {`,
        `  return <div>{children}</div>;`,
        `}`,
        `export const meta = {`,
        `  kind: "atom",`,
        `  examples: [{ name: "chain", props: { children: c } }],`,
        `};`,
      ].join("\n")
    );
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const content = await readFile(join(dsDir, "chain.showcase.tsx"), "utf8");
    // Both locals must be present (a is a dependency of b, which is in c's source)
    expect(content).toContain("const a =");
    expect(content).toContain("const b =");
    // `a` must appear before `b` so `b`'s initializer can reference `a`
    const posA = content.indexOf("const a =");
    const posB = content.indexOf("const b =");
    expect(posA).toBeLessThan(posB);
  });
});

// ── Bug A: undefined props emitted as null (issue #72 follow-up) ─────────────
// Props set to `undefined` in meta examples must be omitted from the
// generated JSX, not emitted as `={null}` or `={undefined}` — both break tsc
// for non-nullable prop types.

describe("Bug A — undefined props are omitted from generated JSX", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fresh();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prop explicitly set to undefined in examples[] is omitted from JSX attributes", async () => {
    const dsDir = join(dir, "design-system", "composites");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "summary.tsx"),
      [
        `import React from "react";`,
        `export function Summary({ status, reference }: { status: string; reference?: string }) {`,
        `  return <div>{status}{reference}</div>;`,
        `}`,
        `export const meta = {`,
        `  kind: "composite",`,
        `  examples: [`,
        `    {`,
        `      name: "no-reference",`,
        `      props: { status: "draft", reference: undefined },`,
        `    },`,
        `  ],`,
        `};`,
      ].join("\n")
    );
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const content = await readFile(join(dsDir, "summary.showcase.tsx"), "utf8");
    // Must render the component
    expect(content).toContain("<Summary");
    // `reference` was undefined — must NOT appear as an attribute at all
    expect(content).not.toContain("reference=");
    // Must NOT emit null for undefined props
    expect(content).not.toContain("reference={null}");
    expect(content).not.toContain("reference={undefined}");
    // status was a string — must appear
    expect(content).toContain('status="draft"');
  });

});

// ── Bug B: nested object properties inside imported fixtures resolve to null ──
// When resolving `fixture[i].nested.prop`, the depth limit (previously 10) was
// exceeded for deeply-nested meta → examples → props → identifier → element
// access → resolveImportedValue → array → object → nested object → property.
// Increasing the limit to 20 allows full resolution.

describe("Bug B — nested object properties in imported fixtures resolve correctly", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fresh();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("array[i].nestedObj.prop resolves to the string value, not null", async () => {
    const dsDir = join(dir, "design-system", "composites");
    const fixturesDir = join(dir, "design-system", "_fixtures");
    await mkdir(dsDir, { recursive: true });
    await mkdir(fixturesDir, { recursive: true });
    // package.json needed so findConsumerRoot() can locate the project root and
    // resolveAtPrefix() can read tsconfig paths for @/ alias resolution.
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-consumer" }, null, 2));
    // Fixture file with a nested object property
    await writeFile(
      join(fixturesDir, "task-fixtures.ts"),
      [
        `export interface Assignee { name: string; avatarUrl?: string }`,
        `export interface TaskFixture { title: string; assignee: Assignee }`,
        `export const acmeTasks: TaskFixture[] = [`,
        `  { title: "Task one", assignee: { name: "Marcus Webb" } },`,
        `  { title: "Task two", assignee: { name: "Sara Kim" } },`,
        `];`,
      ].join("\n")
    );
    // tsconfig so @/ alias resolution works
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }, null, 2)
    );
    await writeFile(
      join(dsDir, "task-row.tsx"),
      [
        `import React from "react";`,
        `import { acmeTasks } from "@/design-system/_fixtures/task-fixtures";`,
        `export function TaskRow({ title, assignee }: { title: string; assignee: { name: string } }) {`,
        `  return <div>{title} — {assignee.name}</div>;`,
        `}`,
        `export const meta = {`,
        `  kind: "composite",`,
        `  examples: [`,
        `    {`,
        `      name: "in-progress",`,
        `      props: {`,
        `        title: acmeTasks[0].title,`,
        `        assignee: acmeTasks[0].assignee,`,
        `      },`,
        `    },`,
        `  ],`,
        `};`,
      ].join("\n")
    );
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const content = await readFile(join(dsDir, "task-row.showcase.tsx"), "utf8");
    expect(content).toContain("<TaskRow");
    // assignee must be resolved as a complete object — name must NOT be null
    expect(content).not.toContain('{ name: null }');
    // The string value must be present
    expect(content).toContain('"Marcus Webb"');
    // title must also be resolved
    expect(content).toContain('"Task one"');
  });
});
