import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isFixable, getFixer } from "../../src/lib/drift-fixers";
import type { DriftRuleId } from "../../src/lib/drift-rules";
import type { DriftFinding } from "../../src/lib/drift-rules";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

describe("drift-fixers", () => {
  describe("isFixable", () => {
    it("returns true for DRIFT-META-KIND-MISSING", () => {
      expect(isFixable("DRIFT-META-KIND-MISSING")).toBe(true);
    });

    it("returns false for DRIFT-MISPLACED", () => {
      expect(isFixable("DRIFT-MISPLACED")).toBe(false);
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

    it("returns null for unfixable rules", () => {
      const unfixable: DriftRuleId[] = [
        "DRIFT-MISPLACED",
        "DRIFT-MISCLASSIFIED-ATOM",
        "DRIFT-MISCLASSIFIED-COMPOSITE",
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
