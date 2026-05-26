import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { regenIndexes } from "../../src/lib/finalizers/regen-indexes";

describe("regenIndexes", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  async function setupTierDir(tierDir: string, files: Record<string, string>) {
    const absDir = join(dir, "design-system", tierDir);
    await mkdir(absDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(absDir, name), content);
    }
  }

  describe("barrel export generation", () => {
    it("generates barrel exports for atoms", async () => {
      await setupTierDir("atoms", {
        "button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
        "input.tsx": `export function Input() { return <input />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      });

      const changes = await regenIndexes(dir);
      const barrelChange = changes.find(c => c.kind === "write" && c.path === "design-system/atoms/index.ts");
      expect(barrelChange).toBeDefined();
      const content = (barrelChange as any).after.toString("utf8");
      expect(content).toBe(
        `export * from "./button";\nexport * from "./input";\n`,
      );
    });

    it("generates barrel exports for composites", async () => {
      await setupTierDir("composites", {
        "toolbar.tsx": `export function Toolbar() { return <div />; }\nexport const meta = { kind: "composite" as const, examples: [] };\n`,
      });

      const changes = await regenIndexes(dir);
      const barrelChange = changes.find(c => c.kind === "write" && c.path === "design-system/composites/index.ts");
      expect(barrelChange).toBeDefined();
      const content = (barrelChange as any).after.toString("utf8");
      expect(content).toBe(`export * from "./toolbar";\n`);
    });

    it("generates barrel exports for patterns", async () => {
      await setupTierDir("patterns", {
        "layout.tsx": `export function Layout({ children }) { return <div>{children}</div>; }\nexport const meta = { kind: "pattern" as const, examples: [] };\n`,
      });

      const changes = await regenIndexes(dir);
      const barrelChange = changes.find(c => c.kind === "write" && c.path === "design-system/patterns/index.ts");
      expect(barrelChange).toBeDefined();
      const content = (barrelChange as any).after.toString("utf8");
      expect(content).toBe(`export * from "./layout";\n`);
    });

    it("excludes companion files from barrel exports", async () => {
      await setupTierDir("atoms", {
        "button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
        "button.showcase.tsx": `export default function ButtonShowcase() { return <div />; }`,
        "button.test.tsx": `describe("Button", () => {});`,
        "button.stories.tsx": `export default { title: "Button" };`,
        "button.snapshot.tsx": `export default function() { return null; }`,
      });

      const changes = await regenIndexes(dir);
      const barrelChange = changes.find(c => c.kind === "write" && c.path === "design-system/atoms/index.ts");
      expect(barrelChange).toBeDefined();
      const content = (barrelChange as any).after.toString("utf8");
      expect(content).toBe(`export * from "./button";\n`);
      expect(content).not.toContain("showcase");
      expect(content).not.toContain("test");
      expect(content).not.toContain("stories");
      expect(content).not.toContain("snapshot");
    });

    it("sorts exports alphabetically", async () => {
      await setupTierDir("atoms", {
        "chip.tsx": `export function Chip() { return <span />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
        "alert.tsx": `export function Alert() { return <div />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
        "button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      });

      const changes = await regenIndexes(dir);
      const barrelChange = changes.find(c => c.kind === "write" && c.path === "design-system/atoms/index.ts");
      const content = (barrelChange as any).after.toString("utf8");
      const lines = content.trim().split("\n");
      expect(lines[0]).toContain("alert");
      expect(lines[1]).toContain("button");
      expect(lines[2]).toContain("chip");
    });

    it("skips barrel change when content matches existing index.ts", async () => {
      await setupTierDir("atoms", {
        "button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      });
      await writeFile(
        join(dir, "design-system/atoms/index.ts"),
        `export * from "./button";\n`,
      );

      const changes = await regenIndexes(dir);
      const barrelChange = changes.find(c => c.kind === "write" && c.path === "design-system/atoms/index.ts");
      expect(barrelChange).toBeUndefined();
    });

    it("overwrites stale barrel content", async () => {
      await setupTierDir("atoms", {
        "button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
        "input.tsx": `export function Input() { return <input />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      });
      await writeFile(
        join(dir, "design-system/atoms/index.ts"),
        `export { Button } from "./button";\n`,
      );

      const changes = await regenIndexes(dir);
      const barrelChange = changes.find(c => c.kind === "write" && c.path === "design-system/atoms/index.ts");
      expect(barrelChange).toBeDefined();
      const content = (barrelChange as any).after.toString("utf8");
      expect(content).toContain("button");
      expect(content).toContain("input");
    });

    it("skips tier directories that do not exist", async () => {
      await setupTierDir("atoms", {
        "button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      });
      // composites/ and patterns/ do not exist

      const changes = await regenIndexes(dir);
      const compositesBarrel = changes.find(c => c.kind === "write" && c.path === "design-system/composites/index.ts");
      const patternsBarrel = changes.find(c => c.kind === "write" && c.path === "design-system/patterns/index.ts");
      expect(compositesBarrel).toBeUndefined();
      expect(patternsBarrel).toBeUndefined();
    });

    it("sets before to null when barrel does not exist yet", async () => {
      await setupTierDir("atoms", {
        "button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      });

      const changes = await regenIndexes(dir);
      const barrelChange = changes.find(c => c.kind === "write" && c.path === "design-system/atoms/index.ts");
      expect(barrelChange).toBeDefined();
      expect((barrelChange as any).before).toBeNull();
    });

    it("sets before to existing content when barrel exists", async () => {
      const existing = `export { OldExport } from "./old";\n`;
      await setupTierDir("atoms", {
        "button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      });
      await writeFile(join(dir, "design-system/atoms/index.ts"), existing);

      const changes = await regenIndexes(dir);
      const barrelChange = changes.find(c => c.kind === "write" && c.path === "design-system/atoms/index.ts");
      expect(barrelChange).toBeDefined();
      expect((barrelChange as any).before.toString("utf8")).toBe(existing);
    });
  });

  describe("manifest.json generation", () => {
    it("generates manifest.json with component entries", async () => {
      await setupTierDir("atoms", {
        "button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      });
      await setupTierDir("composites", {
        "toolbar.tsx": `import { Button } from "@/design-system/atoms/button";\nexport function Toolbar() { return <div><Button /></div>; }\nexport const meta = { kind: "composite" as const, examples: [] };\n`,
      });

      const changes = await regenIndexes(dir);
      const manifestChange = changes.find(c => c.kind === "write" && c.path === "design-system/manifest.json");
      expect(manifestChange).toBeDefined();

      const manifest = JSON.parse((manifestChange as any).after.toString("utf8"));
      expect(manifest.components).toHaveLength(2);

      const button = manifest.components.find((c: any) => c.name === "button");
      expect(button).toMatchObject({
        name: "button",
        tier: "atom",
        kind: "atom",
        path: "design-system/atoms/button.tsx",
        path_no_ext: "design-system/atoms/button",
      });

      const toolbar = manifest.components.find((c: any) => c.name === "toolbar");
      expect(toolbar).toMatchObject({
        name: "toolbar",
        tier: "composite",
        kind: "composite",
        path: "design-system/composites/toolbar.tsx",
        path_no_ext: "design-system/composites/toolbar",
      });
    });

    it("detects companion files in manifest entries", async () => {
      await setupTierDir("atoms", {
        "button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
        "button.showcase.tsx": `export default function ButtonShowcase() { return <div />; }`,
        "button.test.tsx": `describe("Button", () => {});`,
      });

      const changes = await regenIndexes(dir);
      const manifestChange = changes.find(c => c.kind === "write" && c.path === "design-system/manifest.json");
      const manifest = JSON.parse((manifestChange as any).after.toString("utf8"));

      const button = manifest.components.find((c: any) => c.name === "button");
      expect(button.has_showcase).toBe(true);
      expect(button.has_test).toBe(true);
    });

    it("reports has_showcase=false and has_test=false when no companions", async () => {
      await setupTierDir("atoms", {
        "chip.tsx": `export function Chip() { return <span />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      });

      const changes = await regenIndexes(dir);
      const manifestChange = changes.find(c => c.kind === "write" && c.path === "design-system/manifest.json");
      const manifest = JSON.parse((manifestChange as any).after.toString("utf8"));

      const chip = manifest.components.find((c: any) => c.name === "chip");
      expect(chip.has_showcase).toBe(false);
      expect(chip.has_test).toBe(false);
    });

    it("uses meta.kind when present, falls back to tier-inferred kind", async () => {
      await setupTierDir("atoms", {
        "button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
        "chip.tsx": `export function Chip() { return <span />; }\n`, // no meta.kind
      });

      const changes = await regenIndexes(dir);
      const manifestChange = changes.find(c => c.kind === "write" && c.path === "design-system/manifest.json");
      const manifest = JSON.parse((manifestChange as any).after.toString("utf8"));

      const button = manifest.components.find((c: any) => c.name === "button");
      expect(button.kind).toBe("atom");

      const chip = manifest.components.find((c: any) => c.name === "chip");
      expect(chip.kind).toBe("atom"); // falls back to tier-inferred kind
    });

    it("manifest has a generated timestamp", async () => {
      await setupTierDir("atoms", {
        "button.tsx": `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      });

      const changes = await regenIndexes(dir);
      const manifestChange = changes.find(c => c.kind === "write" && c.path === "design-system/manifest.json");
      const manifest = JSON.parse((manifestChange as any).after.toString("utf8"));
      expect(manifest.generated).toBeDefined();
      expect(() => new Date(manifest.generated)).not.toThrow();
    });

    it("returns empty changes when no design-system directory exists", async () => {
      const changes = await regenIndexes(dir);
      expect(changes).toHaveLength(0);
    });

    it("handles empty tier directories", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });

      const changes = await regenIndexes(dir);
      // No barrel change for empty dir (empty === ""), no manifest change (no components)
      const barrelChange = changes.find(c => c.kind === "write" && c.path === "design-system/atoms/index.ts");
      expect(barrelChange).toBeUndefined();
    });
  });
});
