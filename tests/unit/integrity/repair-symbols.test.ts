import { describe, it, expect } from "vitest";
import { repairUnresolvedSymbols } from "../../../src/lib/integrity/repair-symbols";
import type { RepairEnv } from "../../../src/lib/integrity/repair-symbols";

import { analyzeResolution } from "../../../src/lib/integrity/resolve-symbols";

/** Resolution environment that can prove nothing — every symbol is unresolvable. */
const NEVER: RepairEnv = { resolve: () => null };

/** Build a RepairEnv from a fixed symbol→source table; anything else is unprovable. */
function envFrom(table: Record<string, { specifier: string; kind?: "named" | "default" }>): RepairEnv {
  return {
    resolve: (s) => {
      const hit = table[s];
      return hit ? { specifier: hit.specifier, kind: hit.kind ?? "named" } : null;
    },
  };
}

describe("repairUnresolvedSymbols", () => {
  describe("prove-or-leave boundary (#260)", () => {
    it("leaves an unprovable symbol in `remaining` and never touches the source", () => {
      const source = `export function Widget() {\n  return <div>{mysteryHelper()}</div>;\n}\n`;

      const result = repairUnresolvedSymbols(source, "design-system/atoms/widget.tsx", NEVER);

      expect(result.repaired).toBe(false);
      expect(result.remaining).toContain("mysteryHelper");
      expect(result.source).toBe(source);
    });
  });

  describe("proven repair", () => {
    it("adds a named import for a proven symbol and clears it from remaining", () => {
      const source = `export function Row() {\n  return <Button>ok</Button>;\n}\n`;
      const env = envFrom({ Button: { specifier: "@/design-system/atoms/button" } });

      const result = repairUnresolvedSymbols(source, "design-system/atoms/row.tsx", env);

      expect(result.repaired).toBe(true);
      expect(result.remaining).toEqual([]);
      expect(result.source).toContain(`import { Button } from "@/design-system/atoms/button";`);
      // The repaired source must actually bind the symbol now.
      expect(analyzeResolution(result.source, "design-system/atoms/row.tsx").unresolved).toEqual([]);
    });

    it("partial repair: fixes the proven symbol, leaves the unprovable one flagged", () => {
      const source = `export function Row() {\n  return <Button>{mystery()}</Button>;\n}\n`;
      const env = envFrom({ Button: { specifier: "@/design-system/atoms/button" } });

      const result = repairUnresolvedSymbols(source, "design-system/atoms/row.tsx", env);

      expect(result.repaired).toBe(true);
      expect(result.source).toContain(`import { Button } from "@/design-system/atoms/button";`);
      expect(result.remaining).toEqual(["mystery"]);
    });

    it("merges multiple proven named symbols from one specifier into a single import", () => {
      const source = `export function Row() {\n  return <NavRow>{format("d")}</NavRow>;\n}\n`;
      const env = envFrom({
        NavRow: { specifier: "@/design-system/atoms/nav-row" },
        format: { specifier: "date-fns" },
      });

      const result = repairUnresolvedSymbols(source, "design-system/atoms/row.tsx", env);

      expect(result.source).toContain(`import { format } from "date-fns";`);
      expect(result.source).toContain(`import { NavRow } from "@/design-system/atoms/nav-row";`);
      expect(result.remaining).toEqual([]);
    });
  });
});
