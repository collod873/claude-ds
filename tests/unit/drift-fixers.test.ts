import { describe, it, expect } from "vitest";
import { isFixable, getFixer } from "../../src/lib/drift-fixers";
import type { DriftRuleId } from "../../src/lib/drift-rules";

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
});
