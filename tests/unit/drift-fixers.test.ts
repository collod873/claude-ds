import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isFixable, getFixer, isInteractive, makeNoTtyPrompt, getFixerPriority } from "../../src/lib/drift-fixers";
import type { DriftFixer, FixResult, FixerOpts } from "../../src/lib/drift-fixers";
import type { DriftRuleId } from "../../src/lib/drift-rules";
import type { DriftFinding } from "../../src/lib/drift-rules";
import type { Change } from "../../src/lib/operation";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile, stat, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";

async function applyChanges(cwd: string, changes: Change[]): Promise<void> {
  for (const change of changes) {
    if (change.kind === "write") {
      await mkdir(dirname(join(cwd, change.path)), { recursive: true });
      await writeFile(join(cwd, change.path), change.after);
    } else if (change.kind === "rename") {
      await mkdir(dirname(join(cwd, change.after)), { recursive: true });
      await rename(join(cwd, change.path), join(cwd, change.after));
    } else if (change.kind === "delete") {
      try { await unlink(join(cwd, change.path)); } catch { /* */ }
    }
  }
}

async function fixAndApply(fn: DriftFixer, finding: DriftFinding, cwd: string, opts?: FixerOpts): Promise<FixResult> {
  const result = await fn(finding, cwd, opts);
  await applyChanges(cwd, result.changes);
  return result;
}

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

    it("returns true for DRIFT-DS-IMPORTS-FEATURE", () => {
      expect(isFixable("DRIFT-DS-IMPORTS-FEATURE")).toBe(true);
    });

    it("returns true for DRIFT-INLINE-STATIC-STYLE", () => {
      expect(isFixable("DRIFT-INLINE-STATIC-STYLE")).toBe(true);
    });

    it("returns true for DRIFT-RAW-PRIMITIVE", () => {
      expect(isFixable("DRIFT-RAW-PRIMITIVE")).toBe(true);
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

    it("returns a function for DRIFT-DS-IMPORTS-FEATURE", () => {
      expect(getFixer("DRIFT-DS-IMPORTS-FEATURE")).toBeTypeOf("function");
    });

    it("returns a function for DRIFT-RAW-PRIMITIVE", () => {
      expect(getFixer("DRIFT-RAW-PRIMITIVE")).toBeTypeOf("function");
    });

    it("returns null for unfixable rules", () => {
      const unfixable: DriftRuleId[] = [
        "DRIFT-PATTERN-NO-SLOTS",
        "DRIFT-PATTERN-IMPORTS-PATTERN",
        "DRIFT-CVA-VARIANT-UNRENDERED",
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

  describe("getFixerPriority", () => {
    it("extract-to-atom (DRIFT-RAW-PRIMITIVE) runs at priority 0", () => {
      expect(getFixerPriority("DRIFT-RAW-PRIMITIVE")).toBe(0);
    });

    it("relocation (DRIFT-MISPLACED) runs at priority 1", () => {
      expect(getFixerPriority("DRIFT-MISPLACED")).toBe(1);
    });

    it("source-rewrite fixers run at priority 2", () => {
      expect(getFixerPriority("DRIFT-INLINE-STATIC-STYLE")).toBe(2);
      expect(getFixerPriority("DRIFT-DS-IMPORTS-FEATURE")).toBe(2);
    });

    it("meta-only fixers run at priority 3", () => {
      expect(getFixerPriority("DRIFT-META-KIND-MISSING")).toBe(3);
      expect(getFixerPriority("DRIFT-MISCLASSIFIED-ATOM")).toBe(3);
      expect(getFixerPriority("DRIFT-MISCLASSIFIED-COMPOSITE")).toBe(3);
    });

    it("returns Infinity for unfixable rules", () => {
      expect(getFixerPriority("DRIFT-PATTERN-NO-SLOTS")).toBe(Infinity);
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
        const result = await fixAndApply(fixer,finding, dir, { prompt: mockPrompt });
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
      const result = await fixAndApply(fixer,finding, dir);

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
      const result = await fixAndApply(fixer,finding, dir);

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
      await fixAndApply(fixer,finding, dir);

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
      const result = await fixAndApply(fixer,finding, dir);

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
      const result = await fixAndApply(fixer,finding, dir);
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
      await fixAndApply(fixer,finding, dir);

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
      const result = await fixAndApply(fixer,finding, dir);

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
      const result = await fixAndApply(fixer,finding, dir);

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
      const result = await fixAndApply(fixer,finding, dir);

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
      const result = await fixAndApply(fixer,finding, dir);

      expect(result.fixed).toBe(true);
      await expect(stat(join(dir, "design-system/atoms/chip.tsx"))).resolves.toBeTruthy();
      await expect(stat(join(dir, "design-system/composites/chip.tsx"))).rejects.toThrow();
      const content = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
      expect(content).toContain('kind: "atom"');
    });
  });

  describe("fixInlineStaticStyle", () => {
    let dir: string;
    beforeEach(async () => { dir = await freshTmpDir(); });
    afterEach(async () => { await cleanup(dir); });

    const TOKENS = {
      color: { background: "#ffffff", foreground: "#111111", primary: "#0070f3" },
      z: { base: 0, dropdown: 1000, modal: 1300 },
      shadow: { sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)" },
    };

    async function setupTokens(tokens = TOKENS) {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await writeFile(join(dir, "design-system/tokens.json"), JSON.stringify(tokens, null, 2));
    }

    function makeFinding(file = "design-system/atoms/card.tsx"): DriftFinding {
      return {
        ruleId: "DRIFT-INLINE-STATIC-STYLE",
        file,
        message: "inline style={} with literal values — use design tokens instead",
      };
    }

    it("replaces a single-match literal value deterministically", async () => {
      await setupTokens();
      const source = `export function Card() {\n  return <div style={{ zIndex: 1000 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

      const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir);

      expect(result.fixed).toBe(true);
      const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
      expect(content).toContain('className="z-dropdown"');
      expect(content).not.toContain("style=");
    });

    it("replaces string literal values (color)", async () => {
      await setupTokens();
      const source = `export function Card() {\n  return <div style={{ color: "#0070f3" }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

      const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir);

      expect(result.fixed).toBe(true);
      const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
      expect(content).toContain('className="color-primary"');
      expect(content).not.toContain("style=");
    });

    it("handles multiple style properties all fixable", async () => {
      await setupTokens();
      const source = `export function Card() {\n  return <div style={{ color: "#0070f3", zIndex: 1000 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

      const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir);

      expect(result.fixed).toBe(true);
      const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
      expect(content).toContain("color-primary");
      expect(content).toContain("z-dropdown");
      expect(content).not.toContain("style=");
    });

    it("does partial replacement — fixable properties removed, unfixable remain", async () => {
      await setupTokens();
      const source = `export function Card() {\n  return <div style={{ zIndex: 1000, width: "500px" }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

      const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir);

      expect(result.fixed).toBe(true);
      const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
      expect(content).toContain('className="z-dropdown"');
      expect(content).toContain('style={{ width: "500px" }}');
    });

    it("defers when no token matches exist", async () => {
      await setupTokens();
      const source = `export function Card() {\n  return <div style={{ width: "500px" }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

      const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir);

      expect(result.fixed).toBe(false);
      const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
      expect(content).toBe(source);
    });

    it("removes style={{}} entirely when all properties replaced", async () => {
      await setupTokens();
      const source = `export function Card() {\n  return <div style={{ zIndex: 1000 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

      const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
      await fixAndApply(fixer,makeFinding(), dir);

      const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
      expect(content).not.toContain("style=");
      expect(content).not.toContain("{{}}");
    });

    it("preserves existing className when adding token classes", async () => {
      await setupTokens();
      const source = `export function Card() {\n  return <div className="existing" style={{ zIndex: 1000 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

      const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir);

      expect(result.fixed).toBe(true);
      const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
      expect(content).toContain('className="existing z-dropdown"');
      expect(content).not.toContain("style=");
    });

    it("prompts on ambiguous matches (multiple token candidates)", async () => {
      const ambiguousTokens = {
        color: { background: "#ffffff", surface: "#ffffff" },
      };
      await setupTokens(ambiguousTokens);
      const source = `export function Card() {\n  return <div style={{ color: "#ffffff" }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

      const choices: string[][] = [];
      const mockPrompt = async (_q: string, opts: string[]) => {
        choices.push(opts);
        return 0 as number | "defer";
      };
      const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir, { prompt: mockPrompt });

      expect(result.fixed).toBe(true);
      expect(choices.length).toBeGreaterThan(0);
      expect(choices[0]).toContain("color-background");
      expect(choices[0]).toContain("color-surface");
    });

    it("defers ambiguous match when prompt returns defer", async () => {
      const ambiguousTokens = {
        color: { background: "#ffffff", surface: "#ffffff" },
      };
      await setupTokens(ambiguousTokens);
      const source = `export function Card() {\n  return <div style={{ color: "#ffffff" }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

      const mockPrompt = async () => "defer" as number | "defer";
      const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir, { prompt: mockPrompt });

      expect(result.fixed).toBe(false);
      const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
      expect(content).toBe(source);
    });

    it("never touches dynamic expressions", async () => {
      await setupTokens();
      const source = `export function Card({ z }) {\n  return <div style={{ zIndex: z }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

      const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir);

      expect(result.fixed).toBe(false);
      const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
      expect(content).toBe(source);
    });

    it("returns fixed:false when tokens.json is missing", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      const source = `export function Card() {\n  return <div style={{ zIndex: 1000 }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

      const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir);

      expect(result.fixed).toBe(false);
      expect(result.message).toMatch(/tokens/i);
    });

    it("returns fixed:false when the source file does not exist", async () => {
      await setupTokens();
      const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir);
      expect(result.fixed).toBe(false);
    });

    it("handles boxShadow → shadow token group", async () => {
      await setupTokens();
      const source = `export function Card() {\n  return <div style={{ boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)" }}>hello</div>;\n}\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/atoms/card.tsx"), source);

      const fixer = getFixer("DRIFT-INLINE-STATIC-STYLE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir);

      expect(result.fixed).toBe(true);
      const content = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
      expect(content).toContain('className="shadow-sm"');
      expect(content).not.toContain("style=");
    });
  });

  describe("fixDsImportsFeature", () => {
    let dir: string;
    beforeEach(async () => { dir = await freshTmpDir(); });
    afterEach(async () => { await cleanup(dir); });

    function makeFinding(file = "design-system/composites/event-card.tsx"): DriftFinding {
      return {
        ruleId: "DRIFT-DS-IMPORTS-FEATURE",
        file,
        message: "design-system file imports from domain root (imports from lib/)",
      };
    }

    it("extracts a pure utility from lib/ to design-system/utils/", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "lib/utils"), { recursive: true });

      await writeFile(join(dir, "lib/utils/format.ts"),
        `export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n`);

      const dsSource = [
        `import { formatDate } from "../../lib/utils/format";`,
        `export function EventCard() { return <div>{formatDate(new Date())}</div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n";
      await writeFile(join(dir, "design-system/composites/event-card.tsx"), dsSource);

      const mockPrompt = async () => 0 as number | "defer";
      const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir, { prompt: mockPrompt });

      expect(result.fixed).toBe(true);

      const utilsContent = await readFile(join(dir, "design-system/utils/format.ts"), "utf8");
      expect(utilsContent).toContain("export function formatDate");

      const dsContent = await readFile(join(dir, "design-system/composites/event-card.tsx"), "utf8");
      expect(dsContent).toContain("@/design-system/utils/format");
      expect(dsContent).not.toContain("lib/utils/format");
    });

    it("rewrites imports project-wide when extracting to utils", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "lib/utils"), { recursive: true });
      await mkdir(join(dir, "src"), { recursive: true });

      await writeFile(join(dir, "lib/utils/format.ts"),
        `export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n`);

      const dsSource = [
        `import { formatDate } from "../../lib/utils/format";`,
        `export function EventCard() { return <div>{formatDate(new Date())}</div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n";
      await writeFile(join(dir, "design-system/composites/event-card.tsx"), dsSource);

      await writeFile(join(dir, "src/page.tsx"),
        `import { formatDate } from "@/lib/utils/format";\nexport default function Page() { return <div>{formatDate(new Date())}</div>; }\n`);

      const mockPrompt = async () => 0 as number | "defer";
      const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
      await fixAndApply(fixer,makeFinding(), dir, { prompt: mockPrompt });

      const pageContent = await readFile(join(dir, "src/page.tsx"), "utf8");
      expect(pageContent).toContain("@/design-system/utils/format");
      expect(pageContent).not.toContain("@/lib/utils/format");
    });

    it("does not offer extract-to-utils when symbol has transitive domain deps", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "lib/api"), { recursive: true });
      await mkdir(join(dir, "features/auth"), { recursive: true });

      await writeFile(join(dir, "features/auth/session.ts"),
        `export function getSession() { return { user: "test" }; }\n`);

      await writeFile(join(dir, "lib/api/client.ts"),
        `import { getSession } from "../../features/auth/session";\nexport function apiClient() { return getSession(); }\n`);

      const dsSource = [
        `import { apiClient } from "../../lib/api/client";`,
        `export function UserBadge() { return <div>{apiClient()}</div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n";
      await writeFile(join(dir, "design-system/composites/user-badge.tsx"), dsSource);

      const promptOptions: string[][] = [];
      const mockPrompt = async (_q: string, opts: string[]) => {
        promptOptions.push(opts);
        return 0 as number | "defer";
      };
      const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
      await fixAndApply(fixer,makeFinding("design-system/composites/user-badge.tsx"), dir, { prompt: mockPrompt });

      expect(promptOptions.length).toBeGreaterThan(0);
      const options = promptOptions[0];
      expect(options.some(o => o.toLowerCase().includes("extract"))).toBe(false);
      expect(options.some(o => o.toLowerCase().includes("prop"))).toBe(true);
    });

    it("offers convert-to-prop only for pure functions with ≤2 params", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "lib/utils"), { recursive: true });

      await writeFile(join(dir, "lib/utils/complex.ts"),
        `export function complexFn(a: string, b: number, c: boolean): string { return a + b + c; }\n`);

      const dsSource = [
        `import { complexFn } from "../../lib/utils/complex";`,
        `export function Widget() { return <div>{complexFn("a", 1, true)}</div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n";
      await writeFile(join(dir, "design-system/composites/widget.tsx"), dsSource);

      const promptOptions: string[][] = [];
      const mockPrompt = async (_q: string, opts: string[]) => {
        promptOptions.push(opts);
        return 0 as number | "defer";
      };
      const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
      await fixAndApply(fixer,makeFinding("design-system/composites/widget.tsx"), dir, { prompt: mockPrompt });

      expect(promptOptions.length).toBeGreaterThan(0);
      const options = promptOptions[0];
      expect(options.some(o => o.toLowerCase().includes("extract"))).toBe(true);
      expect(options.some(o => o.toLowerCase().includes("prop"))).toBe(false);
    });

    it("offers convert-to-prop for simple constants", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "lib/config"), { recursive: true });

      await writeFile(join(dir, "lib/config/theme.ts"),
        `export const PRIMARY_COLOR = "#0070f3";\n`);

      const dsSource = [
        `import { PRIMARY_COLOR } from "../../lib/config/theme";`,
        `export function Badge() { return <span style={{ color: PRIMARY_COLOR }}>badge</span>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n";
      await writeFile(join(dir, "design-system/composites/badge.tsx"), dsSource);

      const promptOptions: string[][] = [];
      const mockPrompt = async (_q: string, opts: string[]) => {
        promptOptions.push(opts);
        return 0 as number | "defer";
      };
      const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
      await fixAndApply(fixer,makeFinding("design-system/composites/badge.tsx"), dir, { prompt: mockPrompt });

      expect(promptOptions.length).toBeGreaterThan(0);
      const options = promptOptions[0];
      expect(options.some(o => o.toLowerCase().includes("extract"))).toBe(true);
      expect(options.some(o => o.toLowerCase().includes("prop"))).toBe(true);
    });

    it("converts to prop injection — removes import and adds prop", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "lib/utils"), { recursive: true });

      await writeFile(join(dir, "lib/utils/format.ts"),
        `export function formatDate(d: Date): string { return d.toISOString(); }\n`);

      const dsSource = [
        `import { formatDate } from "../../lib/utils/format";`,
        `export function EventCard({ title }: { title: string }) {`,
        `  return <div>{title}: {formatDate(new Date())}</div>;`,
        `}`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n";
      await writeFile(join(dir, "design-system/composites/event-card.tsx"), dsSource);

      const mockPrompt = async (_q: string, opts: string[]) => {
        return opts.findIndex(o => o.toLowerCase().includes("prop")) as number | "defer";
      };
      const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir, { prompt: mockPrompt });

      expect(result.fixed).toBe(true);
      const content = await readFile(join(dir, "design-system/composites/event-card.tsx"), "utf8");
      expect(content).not.toContain("lib/utils/format");
      expect(content).toContain("formatDate");
      expect(content).toMatch(/\bformatDate\b.*\}/); // prop in destructuring
    });

    it("defers and writes exception entry", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "design-system"), { recursive: true });
      await mkdir(join(dir, "lib/utils"), { recursive: true });

      await writeFile(join(dir, "lib/utils/format.ts"),
        `export function formatDate(d: Date): string { return d.toISOString(); }\n`);

      const dsSource = [
        `import { formatDate } from "../../lib/utils/format";`,
        `export function EventCard() { return <div>{formatDate(new Date())}</div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n";
      await writeFile(join(dir, "design-system/composites/event-card.tsx"), dsSource);

      const mockPrompt = async () => "defer" as number | "defer";
      const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir, { prompt: mockPrompt });

      expect(result.fixed).toBe(false);
      expect(result.message).toMatch(/defer/i);
    });

    it("returns fixed:false when the file does not exist", async () => {
      const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir);
      expect(result.fixed).toBe(false);
    });

    it("returns fixed:false when no prompt callback is provided", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "lib/utils"), { recursive: true });

      await writeFile(join(dir, "lib/utils/format.ts"),
        `export function formatDate(d: Date): string { return d.toISOString(); }\n`);

      const dsSource = [
        `import { formatDate } from "../../lib/utils/format";`,
        `export function EventCard() { return <div>{formatDate(new Date())}</div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n";
      await writeFile(join(dir, "design-system/composites/event-card.tsx"), dsSource);

      const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir);
      expect(result.fixed).toBe(false);
    });

    it("handles @/ alias imports", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "lib/utils"), { recursive: true });

      await writeFile(join(dir, "lib/utils/format.ts"),
        `export function formatDate(d: Date): string { return d.toISOString(); }\n`);

      const dsSource = [
        `import { formatDate } from "@/lib/utils/format";`,
        `export function EventCard() { return <div>{formatDate(new Date())}</div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n";
      await writeFile(join(dir, "design-system/composites/event-card.tsx"), dsSource);

      const mockPrompt = async () => 0 as number | "defer";
      const fixer = getFixer("DRIFT-DS-IMPORTS-FEATURE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir, { prompt: mockPrompt });

      expect(result.fixed).toBe(true);
      const dsContent = await readFile(join(dir, "design-system/composites/event-card.tsx"), "utf8");
      expect(dsContent).toContain("@/design-system/utils/format");
      expect(dsContent).not.toContain("@/lib/utils/format");
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
      const result = await fixAndApply(fixer,finding, dir);
      expect(result.fixed).toBe(false);
      expect(result.message).toMatch(/could not read/);
    });

    it("appends meta.kind export using location tier", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await writeFile(join(dir, "design-system/atoms/button.tsx"), "export function Button() { return <button />; }\n");
      const fixer = getFixer("DRIFT-META-KIND-MISSING")!;
      const result = await fixAndApply(fixer,finding, dir);
      expect(result.fixed).toBe(true);
      const content = await readFile(join(dir, "design-system/atoms/button.tsx"), "utf8");
      expect(content).toMatch(/export const meta = \{ kind: "atom" as const, examples: \[\] \}/);
    });
  });

  describe("fixRawPrimitive", () => {
    let dir: string;
    beforeEach(async () => { dir = await freshTmpDir(); });
    afterEach(async () => { await cleanup(dir); });

    function makeFinding(file = "design-system/composites/toolbar.tsx"): DriftFinding {
      return {
        ruleId: "DRIFT-RAW-PRIMITIVE",
        file,
        message: "raw HTML primitive: 1 <button> — use design-system atoms instead",
      };
    }

    describe("Path A — atom already exists", () => {
      it("rewrites raw <button> to <Button> with variant from prompt", async () => {
        await mkdir(join(dir, "design-system/atoms"), { recursive: true });
        await mkdir(join(dir, "design-system/composites"), { recursive: true });

        const atomSource = [
          `import { cva } from "class-variance-authority";`,
          `const buttonVariants = cva("btn", {`,
          `  variants: {`,
          `    variant: { default: "btn-default", ghost: "btn-ghost", outline: "btn-outline" },`,
          `    size: { default: "btn-md", sm: "btn-sm", icon: "btn-icon" },`,
          `  },`,
          `  defaultVariants: { variant: "default", size: "default" },`,
          `});`,
          `export function Button({ variant, size, ...props }) {`,
          `  return <button className={buttonVariants({ variant, size })} {...props} />;`,
          `}`,
          `export const meta = { kind: "atom" as const, examples: [] };`,
        ].join("\n") + "\n";
        await writeFile(join(dir, "design-system/atoms/button.tsx"), atomSource);

        const compositeSource = [
          `export function Toolbar() {`,
          `  return (`,
          `    <div>`,
          `      <button className="ghost-btn" onClick={handleClick}>Click</button>`,
          `    </div>`,
          `  );`,
          `}`,
          `export const meta = { kind: "composite" as const, examples: [] };`,
        ].join("\n") + "\n";
        await writeFile(join(dir, "design-system/composites/toolbar.tsx"), compositeSource);

        const mockPrompt = async () => 1 as number | "defer"; // select "ghost"
        const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
        const result = await fixAndApply(fixer,makeFinding(), dir, { prompt: mockPrompt });

        expect(result.fixed).toBe(true);
        const content = await readFile(join(dir, "design-system/composites/toolbar.tsx"), "utf8");
        expect(content).toContain("<Button");
        expect(content).toContain('variant="ghost"');
        expect(content).toContain("@/design-system/atoms/button");
        expect(content).not.toContain("<button");
      });

      it("adds import statement for the atom", async () => {
        await mkdir(join(dir, "design-system/atoms"), { recursive: true });
        await mkdir(join(dir, "design-system/composites"), { recursive: true });

        const atomSource = [
          `export function Button(props) { return <button {...props} />; }`,
          `export const meta = { kind: "atom" as const, examples: [] };`,
        ].join("\n") + "\n";
        await writeFile(join(dir, "design-system/atoms/button.tsx"), atomSource);

        const compositeSource = [
          `export function Toolbar() {`,
          `  return <div><button onClick={fn}>Go</button></div>;`,
          `}`,
          `export const meta = { kind: "composite" as const, examples: [] };`,
        ].join("\n") + "\n";
        await writeFile(join(dir, "design-system/composites/toolbar.tsx"), compositeSource);

        const mockPrompt = async () => 0 as number | "defer";
        const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
        await fixAndApply(fixer,makeFinding(), dir, { prompt: mockPrompt });

        const content = await readFile(join(dir, "design-system/composites/toolbar.tsx"), "utf8");
        expect(content).toMatch(/import\s+\{\s*Button\s*\}\s+from\s+/);
        expect(content).toContain("@/design-system/atoms/button");
      });

      it("handles multiple raw elements in the same file", async () => {
        await mkdir(join(dir, "design-system/atoms"), { recursive: true });
        await mkdir(join(dir, "design-system/composites"), { recursive: true });

        await writeFile(join(dir, "design-system/atoms/button.tsx"), [
          `export function Button(props) { return <button {...props} />; }`,
          `export const meta = { kind: "atom" as const, examples: [] };`,
        ].join("\n") + "\n");
        await writeFile(join(dir, "design-system/atoms/input.tsx"), [
          `export function Input(props) { return <input {...props} />; }`,
          `export const meta = { kind: "atom" as const, examples: [] };`,
        ].join("\n") + "\n");

        const compositeSource = [
          `export function SearchForm() {`,
          `  return (`,
          `    <form>`,
          `      <input type="text" placeholder="Search..." />`,
          `      <button type="submit">Go</button>`,
          `    </form>`,
          `  );`,
          `}`,
          `export const meta = { kind: "composite" as const, examples: [] };`,
        ].join("\n") + "\n";
        await writeFile(join(dir, "design-system/composites/search-form.tsx"), compositeSource);

        const mockPrompt = async () => 0 as number | "defer";
        const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
        const result = await fixAndApply(fixer,
          makeFinding("design-system/composites/search-form.tsx"),
          dir,
          { prompt: mockPrompt },
        );

        expect(result.fixed).toBe(true);
        const content = await readFile(join(dir, "design-system/composites/search-form.tsx"), "utf8");
        expect(content).toContain("<Button");
        expect(content).toContain("<Input");
        expect(content).not.toContain("<button");
        expect(content).not.toContain("<input");
        expect(content).toContain("@/design-system/atoms/button");
        expect(content).toContain("@/design-system/atoms/input");
      });

      it("defers when prompt returns defer", async () => {
        await mkdir(join(dir, "design-system/atoms"), { recursive: true });
        await mkdir(join(dir, "design-system/composites"), { recursive: true });

        await writeFile(join(dir, "design-system/atoms/button.tsx"), [
          `export function Button(props) { return <button {...props} />; }`,
          `export const meta = { kind: "atom" as const, examples: [] };`,
        ].join("\n") + "\n");
        await writeFile(join(dir, "design-system/composites/toolbar.tsx"), [
          `export function Toolbar() { return <div><button>X</button></div>; }`,
          `export const meta = { kind: "composite" as const, examples: [] };`,
        ].join("\n") + "\n");

        const mockPrompt = async () => "defer" as number | "defer";
        const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
        const result = await fixAndApply(fixer,makeFinding(), dir, { prompt: mockPrompt });

        expect(result.fixed).toBe(false);
      });

      it("preserves non-className attributes on raw elements", async () => {
        await mkdir(join(dir, "design-system/atoms"), { recursive: true });
        await mkdir(join(dir, "design-system/composites"), { recursive: true });

        await writeFile(join(dir, "design-system/atoms/button.tsx"), [
          `export function Button(props) { return <button {...props} />; }`,
          `export const meta = { kind: "atom" as const, examples: [] };`,
        ].join("\n") + "\n");
        const compositeSource = [
          `export function Toolbar() {`,
          `  return <div><button onClick={handleClick} disabled aria-label="save">Save</button></div>;`,
          `}`,
          `export const meta = { kind: "composite" as const, examples: [] };`,
        ].join("\n") + "\n";
        await writeFile(join(dir, "design-system/composites/toolbar.tsx"), compositeSource);

        const mockPrompt = async () => 0 as number | "defer";
        const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
        await fixAndApply(fixer,makeFinding(), dir, { prompt: mockPrompt });

        const content = await readFile(join(dir, "design-system/composites/toolbar.tsx"), "utf8");
        expect(content).toContain("onClick={handleClick}");
        expect(content).toContain("disabled");
        expect(content).toContain('aria-label="save"');
        expect(content).toContain("<Button");
      });
    });

    describe("Path B — extract to atom", () => {
      it("extracts a named internal component ≥20 lines to a new atom", async () => {
        await mkdir(join(dir, "design-system/atoms"), { recursive: true });
        await mkdir(join(dir, "design-system/composites"), { recursive: true });

        const internalLines = Array.from({ length: 20 }, (_, i) =>
          `    const x${i} = ${i};`,
        ).join("\n");
        const compositeSource = [
          `function FilterBarChip({ label, onRemove }) {`,
          internalLines,
          `  return (`,
          `    <span className="chip">`,
          `      {label}`,
          `      <button onClick={onRemove}>×</button>`,
          `    </span>`,
          `  );`,
          `}`,
          ``,
          `export function FilterBar() {`,
          `  return (`,
          `    <div>`,
          `      <FilterBarChip label="status" onRemove={() => {}} />`,
          `    </div>`,
          `  );`,
          `}`,
          `export const meta = { kind: "composite" as const, examples: [] };`,
        ].join("\n") + "\n";
        await writeFile(join(dir, "design-system/composites/filter-bar.tsx"), compositeSource);

        const mockPrompt = async () => 0 as number | "defer"; // accept as "Chip"
        const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
        const result = await fixAndApply(fixer,
          makeFinding("design-system/composites/filter-bar.tsx"),
          dir,
          { prompt: mockPrompt },
        );

        expect(result.fixed).toBe(true);

        // New atom file should exist
        const atomContent = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
        expect(atomContent).toContain("export function Chip");
        expect(atomContent).toContain('kind: "atom"');

        // Composite should now import from atom
        const compositeContent = await readFile(join(dir, "design-system/composites/filter-bar.tsx"), "utf8");
        expect(compositeContent).toContain("@/design-system/atoms/chip");
        expect(compositeContent).toContain("<Chip");
        expect(compositeContent).not.toMatch(/^function FilterBarChip/m);
      });

      it("naming heuristic strips parent prefix", async () => {
        await mkdir(join(dir, "design-system/atoms"), { recursive: true });
        await mkdir(join(dir, "design-system/composites"), { recursive: true });

        const internalLines = Array.from({ length: 20 }, (_, i) =>
          `    const x${i} = ${i};`,
        ).join("\n");
        const compositeSource = [
          `function SearchBarInput({ value }) {`,
          internalLines,
          `  return <input value={value} />;`,
          `}`,
          ``,
          `export function SearchBar() {`,
          `  return <div><SearchBarInput value="" /></div>;`,
          `}`,
          `export const meta = { kind: "composite" as const, examples: [] };`,
        ].join("\n") + "\n";
        await writeFile(join(dir, "design-system/composites/search-bar.tsx"), compositeSource);

        const promptQuestions: string[] = [];
        const mockPrompt = async (q: string) => {
          promptQuestions.push(q);
          return 0 as number | "defer";
        };
        const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
        await fixAndApply(fixer,
          makeFinding("design-system/composites/search-bar.tsx"),
          dir,
          { prompt: mockPrompt },
        );

        // The prompt should mention "Input" (stripped from SearchBarInput)
        expect(promptQuestions.some(q => q.includes("Input"))).toBe(true);
        // Atom file should be named input.tsx
        const atomContent = await readFile(join(dir, "design-system/atoms/input.tsx"), "utf8");
        expect(atomContent).toContain("export function Input");
      });

      it("moves local deps used only by extracted component", async () => {
        await mkdir(join(dir, "design-system/atoms"), { recursive: true });
        await mkdir(join(dir, "design-system/composites"), { recursive: true });

        const internalLines = Array.from({ length: 18 }, (_, i) =>
          `    const x${i} = ${i};`,
        ).join("\n");
        const compositeSource = [
          `type ChipProps = { label: string; onRemove: () => void };`,
          ``,
          `function FilterBarChip({ label, onRemove }: ChipProps) {`,
          internalLines,
          `  return <span>{label}<button onClick={onRemove}>×</button></span>;`,
          `}`,
          ``,
          `export function FilterBar() {`,
          `  return <div><FilterBarChip label="hi" onRemove={() => {}} /></div>;`,
          `}`,
          `export const meta = { kind: "composite" as const, examples: [] };`,
        ].join("\n") + "\n";
        await writeFile(join(dir, "design-system/composites/filter-bar.tsx"), compositeSource);

        const mockPrompt = async () => 0 as number | "defer";
        const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
        await fixAndApply(fixer,
          makeFinding("design-system/composites/filter-bar.tsx"),
          dir,
          { prompt: mockPrompt },
        );

        const atomContent = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
        expect(atomContent).toContain("ChipProps");

        const compositeContent = await readFile(join(dir, "design-system/composites/filter-bar.tsx"), "utf8");
        expect(compositeContent).not.toContain("ChipProps");
      });

      it("keeps local deps used by both extracted component and remaining code", async () => {
        await mkdir(join(dir, "design-system/atoms"), { recursive: true });
        await mkdir(join(dir, "design-system/composites"), { recursive: true });

        const internalLines = Array.from({ length: 18 }, (_, i) =>
          `    const x${i} = ${i};`,
        ).join("\n");
        const compositeSource = [
          `const SHARED_CLASS = "shared-style";`,
          ``,
          `function FilterBarChip({ label }) {`,
          internalLines,
          `  return <span className={SHARED_CLASS}>{label}</span>;`,
          `}`,
          ``,
          `export function FilterBar() {`,
          `  return <div className={SHARED_CLASS}><FilterBarChip label="hi" /></div>;`,
          `}`,
          `export const meta = { kind: "composite" as const, examples: [] };`,
        ].join("\n") + "\n";
        await writeFile(join(dir, "design-system/composites/filter-bar.tsx"), compositeSource);

        const mockPrompt = async () => 0 as number | "defer";
        const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
        await fixAndApply(fixer,
          makeFinding("design-system/composites/filter-bar.tsx"),
          dir,
          { prompt: mockPrompt },
        );

        // Shared dep should remain in composite
        const compositeContent = await readFile(join(dir, "design-system/composites/filter-bar.tsx"), "utf8");
        expect(compositeContent).toContain("SHARED_CLASS");

        // Extracted atom should also have it (duplicated)
        const atomContent = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
        expect(atomContent).toContain("SHARED_CLASS");
      });

      it("skips extraction when component is <20 lines", async () => {
        await mkdir(join(dir, "design-system/atoms"), { recursive: true });
        await mkdir(join(dir, "design-system/composites"), { recursive: true });

        const compositeSource = [
          `function FilterBarChip({ label }) {`,
          `  return <span>{label}</span>;`,
          `}`,
          ``,
          `export function FilterBar() {`,
          `  return <div><FilterBarChip label="hi" /></div>;`,
          `}`,
          `export const meta = { kind: "composite" as const, examples: [] };`,
        ].join("\n") + "\n";
        await writeFile(join(dir, "design-system/composites/filter-bar.tsx"), compositeSource);

        const mockPrompt = async () => 0 as number | "defer";
        const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
        const result = await fixAndApply(fixer,
          makeFinding("design-system/composites/filter-bar.tsx"),
          dir,
          { prompt: mockPrompt },
        );

        // Should not have created an atom file (component too short)
        await expect(stat(join(dir, "design-system/atoms/chip.tsx"))).rejects.toThrow();
      });
    });

    it("returns fixed:false when the file does not exist", async () => {
      const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir);
      expect(result.fixed).toBe(false);
    });

    it("requires interactive prompt", async () => {
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await writeFile(join(dir, "design-system/composites/toolbar.tsx"), [
        `export function Toolbar() { return <div><button>X</button></div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n");

      const fixer = getFixer("DRIFT-RAW-PRIMITIVE")!;
      const result = await fixAndApply(fixer,makeFinding(), dir);
      expect(result.fixed).toBe(false);
    });
  });
});
