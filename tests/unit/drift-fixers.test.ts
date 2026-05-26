import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isFixable, getFixer, isInteractive, makeNoTtyPrompt } from "../../src/lib/drift-fixers";
import type { DriftRuleId } from "../../src/lib/drift-rules";
import type { DriftFinding } from "../../src/lib/drift-rules";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

describe("drift-fixers", () => {
  describe("isFixable", () => {
    it("returns true for DRIFT-META-KIND-MISSING", () => {
      expect(isFixable("DRIFT-META-KIND-MISSING")).toBe(true);
    });

    it("returns true for DRIFT-MISPLACED", () => {
      expect(isFixable("DRIFT-MISPLACED")).toBe(true);
    });

    it("returns true for DRIFT-MISCLASSIFIED-ATOM", () => {
      expect(isFixable("DRIFT-MISCLASSIFIED-ATOM")).toBe(true);
    });

    it("returns true for DRIFT-MISCLASSIFIED-COMPOSITE", () => {
      expect(isFixable("DRIFT-MISCLASSIFIED-COMPOSITE")).toBe(true);
    });

    it("returns false for DRIFT-DS-IMPORTS-FEATURE", () => {
      expect(isFixable("DRIFT-DS-IMPORTS-FEATURE")).toBe(false);
    });

    it("returns false for DRIFT-INLINE-STATIC-STYLE", () => {
      expect(isFixable("DRIFT-INLINE-STATIC-STYLE")).toBe(false);
    });
  });

  describe("getFixer", () => {
    it("returns a function for DRIFT-META-KIND-MISSING", () => {
      expect(getFixer("DRIFT-META-KIND-MISSING")).toBeTypeOf("function");
    });

    it("returns a function for DRIFT-MISPLACED", () => {
      expect(getFixer("DRIFT-MISPLACED")).toBeTypeOf("function");
    });

    it("returns a function for DRIFT-MISCLASSIFIED-ATOM", () => {
      expect(getFixer("DRIFT-MISCLASSIFIED-ATOM")).toBeTypeOf("function");
    });

    it("returns a function for DRIFT-MISCLASSIFIED-COMPOSITE", () => {
      expect(getFixer("DRIFT-MISCLASSIFIED-COMPOSITE")).toBeTypeOf("function");
    });

    it("returns null for unfixable rules", () => {
      const unfixable: DriftRuleId[] = [
        "DRIFT-DS-IMPORTS-FEATURE",
        "DRIFT-PATTERN-NO-SLOTS",
        "DRIFT-PATTERN-IMPORTS-PATTERN",
        "DRIFT-RAW-PRIMITIVE",
        "DRIFT-CVA-VARIANT-UNRENDERED",
        "DRIFT-INLINE-STATIC-STYLE",
      ];
      for (const rule of unfixable) {
        expect(getFixer(rule)).toBeNull();
      }
    });
  });

  describe("isInteractive", () => {
    it("returns false for DRIFT-META-KIND-MISSING (deterministic fixer)", () => {
      expect(isInteractive("DRIFT-META-KIND-MISSING")).toBe(false);
    });

    it("returns false for DRIFT-MISPLACED (deterministic fixer)", () => {
      expect(isInteractive("DRIFT-MISPLACED")).toBe(false);
    });

    it("returns false for DRIFT-MISCLASSIFIED-ATOM (deterministic fixer)", () => {
      expect(isInteractive("DRIFT-MISCLASSIFIED-ATOM")).toBe(false);
    });

    it("returns false for DRIFT-MISCLASSIFIED-COMPOSITE (deterministic fixer)", () => {
      expect(isInteractive("DRIFT-MISCLASSIFIED-COMPOSITE")).toBe(false);
    });
  });

  describe("makeNoTtyPrompt", () => {
    it("always returns 'defer'", async () => {
      const prompt = makeNoTtyPrompt();
      const result = await prompt("Which variant?", ["default", "ghost", "outline"]);
      expect(result).toBe("defer");
    });

    it("returns 'defer' regardless of question or options", async () => {
      const prompt = makeNoTtyPrompt();
      expect(await prompt("Pick one", ["a"])).toBe("defer");
      expect(await prompt("Another?", ["x", "y", "z"])).toBe("defer");
    });
  });

  describe("FixerOpts.prompt", () => {
    it("existing DRIFT-META-KIND-MISSING fixer works with prompt in opts", async () => {
      const dir = await freshTmpDir();
      try {
        await mkdir(join(dir, "design-system/atoms"), { recursive: true });
        await writeFile(join(dir, "design-system/atoms/chip.tsx"), "export function Chip() { return <span />; }\n");
        const fixer = getFixer("DRIFT-META-KIND-MISSING")!;
        const finding: DriftFinding = {
          ruleId: "DRIFT-META-KIND-MISSING",
          file: "design-system/atoms/chip.tsx",
          message: "missing meta.kind",
        };
        const mockPrompt = async () => 0 as number | "defer";
        const result = await fixer(finding, dir, { prompt: mockPrompt });
        expect(result.fixed).toBe(true);
        const content = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
        expect(content).toMatch(/meta/);
      } finally {
        await cleanup(dir);
      }
    });
  });

  describe("fixMisplaced", () => {
    let dir: string;
    beforeEach(async () => { dir = await freshTmpDir(); });
    afterEach(async () => { await cleanup(dir); });

    it("relocates atom from composites/ to atoms/", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      const source = `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/composites/button.tsx"), source);

      const finding: DriftFinding = {
        ruleId: "DRIFT-MISPLACED",
        file: "design-system/composites/button.tsx",
        message: "located in composites/ but classifier says atom",
      };
      const fixer = getFixer("DRIFT-MISPLACED")!;
      const result = await fixer(finding, dir);

      expect(result.fixed).toBe(true);
      await expect(stat(join(dir, "design-system/atoms/button.tsx"))).resolves.toBeTruthy();
      await expect(stat(join(dir, "design-system/composites/button.tsx"))).rejects.toThrow();
    });

    it("moves companion files alongside the primary file", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      const source = `export function Chip() { return <span />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/composites/chip.tsx"), source);
      await writeFile(join(dir, "design-system/composites/chip.showcase.tsx"), "export default function ChipShowcase() {}");
      await writeFile(join(dir, "design-system/composites/chip.test.tsx"), "describe('Chip', () => {})");

      const finding: DriftFinding = {
        ruleId: "DRIFT-MISPLACED",
        file: "design-system/composites/chip.tsx",
        message: "located in composites/ but classifier says atom",
      };
      const fixer = getFixer("DRIFT-MISPLACED")!;
      const result = await fixer(finding, dir);

      expect(result.fixed).toBe(true);
      await expect(stat(join(dir, "design-system/atoms/chip.tsx"))).resolves.toBeTruthy();
      await expect(stat(join(dir, "design-system/atoms/chip.showcase.tsx"))).resolves.toBeTruthy();
      await expect(stat(join(dir, "design-system/atoms/chip.test.tsx"))).resolves.toBeTruthy();
      await expect(stat(join(dir, "design-system/composites/chip.tsx"))).rejects.toThrow();
      await expect(stat(join(dir, "design-system/composites/chip.showcase.tsx"))).rejects.toThrow();
      await expect(stat(join(dir, "design-system/composites/chip.test.tsx"))).rejects.toThrow();
    });

    it("rewrites project-wide imports from old path to new path", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await mkdir(join(dir, "src"), { recursive: true });
      const source = `export function Chip() { return <span />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/composites/chip.tsx"), source);
      await writeFile(
        join(dir, "src/page.tsx"),
        `import { Chip } from "@/design-system/composites/chip";\nexport default function Page() { return <Chip />; }\n`
      );

      const finding: DriftFinding = {
        ruleId: "DRIFT-MISPLACED",
        file: "design-system/composites/chip.tsx",
        message: "located in composites/ but classifier says atom",
      };
      const fixer = getFixer("DRIFT-MISPLACED")!;
      await fixer(finding, dir);

      const pageContent = await readFile(join(dir, "src/page.tsx"), "utf8");
      expect(pageContent).toContain("@/design-system/atoms/chip");
      expect(pageContent).not.toContain("@/design-system/composites/chip");
    });

    it("relocates cleanly with no companions", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      const source = `import { Button } from "@/design-system/atoms/button";\nexport function Toolbar() { return <div><Button /></div>; }\nexport const meta = { kind: "composite" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/toolbar.tsx"), source);

      const finding: DriftFinding = {
        ruleId: "DRIFT-MISPLACED",
        file: "design-system/atoms/toolbar.tsx",
        message: "located in atoms/ but classifier says composite",
      };
      const fixer = getFixer("DRIFT-MISPLACED")!;
      const result = await fixer(finding, dir);

      expect(result.fixed).toBe(true);
      await expect(stat(join(dir, "design-system/composites/toolbar.tsx"))).resolves.toBeTruthy();
      await expect(stat(join(dir, "design-system/atoms/toolbar.tsx"))).rejects.toThrow();
    });

    it("returns fixed:false when the file does not exist", async () => {
      const finding: DriftFinding = {
        ruleId: "DRIFT-MISPLACED",
        file: "design-system/atoms/ghost.tsx",
        message: "located in atoms/ but classifier says composite",
      };
      const fixer = getFixer("DRIFT-MISPLACED")!;
      const result = await fixer(finding, dir);
      expect(result.fixed).toBe(false);
    });

    it("updates barrel exports when index.ts exists", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      const source = `export function Chip() { return <span />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/composites/chip.tsx"), source);
      await writeFile(
        join(dir, "design-system/composites/index.ts"),
        `export { SearchBar } from "./search-bar";\nexport { Chip } from "./chip";\n`,
      );
      await writeFile(
        join(dir, "design-system/atoms/index.ts"),
        `export { Button } from "./button";\n`,
      );

      const finding: DriftFinding = {
        ruleId: "DRIFT-MISPLACED",
        file: "design-system/composites/chip.tsx",
        message: "located in composites/ but classifier says atom",
      };
      const fixer = getFixer("DRIFT-MISPLACED")!;
      await fixer(finding, dir);

      const srcBarrel = await readFile(join(dir, "design-system/composites/index.ts"), "utf8");
      expect(srcBarrel).not.toContain("chip");
      expect(srcBarrel).toContain("search-bar");

      const dstBarrel = await readFile(join(dir, "design-system/atoms/index.ts"), "utf8");
      expect(dstBarrel).toContain("chip");
      expect(dstBarrel).toContain("button");
    });
  });

  describe("fixMisclassifiedAtom", () => {
    let dir: string;
    beforeEach(async () => { dir = await freshTmpDir(); });
    afterEach(async () => { await cleanup(dir); });

    it("flips meta.kind when folder matches classifier (folder right, meta wrong)", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      const source = `import { Button } from "@/design-system/atoms/button";\nexport function Toolbar() { return <div><Button /></div>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/composites/toolbar.tsx"), source);

      const finding: DriftFinding = {
        ruleId: "DRIFT-MISCLASSIFIED-ATOM",
        file: "design-system/composites/toolbar.tsx",
        message: "declares meta.kind=atom but classifier says composite",
      };
      const fixer = getFixer("DRIFT-MISCLASSIFIED-ATOM")!;
      const result = await fixer(finding, dir);

      expect(result.fixed).toBe(true);
      const content = await readFile(join(dir, "design-system/composites/toolbar.tsx"), "utf8");
      expect(content).toContain('kind: "composite"');
      expect(content).not.toContain('kind: "atom"');
    });

    it("relocates when folder also disagrees with classifier", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      const source = `import { Button } from "@/design-system/atoms/button";\nexport function Toolbar() { return <div><Button /></div>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/toolbar.tsx"), source);

      const finding: DriftFinding = {
        ruleId: "DRIFT-MISCLASSIFIED-ATOM",
        file: "design-system/atoms/toolbar.tsx",
        message: "declares meta.kind=atom but classifier says composite",
      };
      const fixer = getFixer("DRIFT-MISCLASSIFIED-ATOM")!;
      const result = await fixer(finding, dir);

      expect(result.fixed).toBe(true);
      await expect(stat(join(dir, "design-system/composites/toolbar.tsx"))).resolves.toBeTruthy();
      await expect(stat(join(dir, "design-system/atoms/toolbar.tsx"))).rejects.toThrow();
      const content = await readFile(join(dir, "design-system/composites/toolbar.tsx"), "utf8");
      expect(content).toContain('kind: "composite"');
    });
  });

  describe("fixMisclassifiedComposite", () => {
    let dir: string;
    beforeEach(async () => { dir = await freshTmpDir(); });
    afterEach(async () => { await cleanup(dir); });

    it("flips meta.kind when folder matches classifier (folder right, meta wrong)", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      const source = `export function Chip() { return <span />; }\nexport const meta = { kind: "composite" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/chip.tsx"), source);

      const finding: DriftFinding = {
        ruleId: "DRIFT-MISCLASSIFIED-COMPOSITE",
        file: "design-system/atoms/chip.tsx",
        message: "declares meta.kind=composite but classifier says atom",
      };
      const fixer = getFixer("DRIFT-MISCLASSIFIED-COMPOSITE")!;
      const result = await fixer(finding, dir);

      expect(result.fixed).toBe(true);
      const content = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
      expect(content).toContain('kind: "atom"');
      expect(content).not.toContain('kind: "composite"');
    });

    it("relocates when folder also disagrees with classifier", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      const source = `export function Chip() { return <span />; }\nexport const meta = { kind: "composite" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/composites/chip.tsx"), source);

      const finding: DriftFinding = {
        ruleId: "DRIFT-MISCLASSIFIED-COMPOSITE",
        file: "design-system/composites/chip.tsx",
        message: "declares meta.kind=composite but classifier says atom",
      };
      const fixer = getFixer("DRIFT-MISCLASSIFIED-COMPOSITE")!;
      const result = await fixer(finding, dir);

      expect(result.fixed).toBe(true);
      await expect(stat(join(dir, "design-system/atoms/chip.tsx"))).resolves.toBeTruthy();
      await expect(stat(join(dir, "design-system/composites/chip.tsx"))).rejects.toThrow();
      const content = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
      expect(content).toContain('kind: "atom"');
    });
  });

  describe("fixMetaKindMissing", () => {
    let dir: string;
    beforeEach(async () => { dir = await freshTmpDir(); });
    afterEach(async () => { await cleanup(dir); });

    const finding: DriftFinding = {
      ruleId: "DRIFT-META-KIND-MISSING",
      file: "design-system/atoms/button.tsx",
      message: "missing meta.kind",
    };

    it("returns fixed:false when the file does not exist", async () => {
      const fixer = getFixer("DRIFT-META-KIND-MISSING")!;
      const result = await fixer(finding, dir);
      expect(result.fixed).toBe(false);
      expect(result.message).toMatch(/could not read/);
    });

    it("appends meta.kind export using location tier", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await writeFile(join(dir, "design-system/atoms/button.tsx"), "export function Button() { return <button />; }\n");
      const fixer = getFixer("DRIFT-META-KIND-MISSING")!;
      const result = await fixer(finding, dir);
      expect(result.fixed).toBe(true);
      const content = await readFile(join(dir, "design-system/atoms/button.tsx"), "utf8");
      expect(content).toMatch(/export const meta = \{ kind: "atom" as const, examples: \[\] \}/);
    });
  });
});
