import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { runFixPass, sortFindingsByPriority } from "../../src/lib/fix-pass";
import type { DriftFinding } from "../../src/lib/drift/index.js";
import { makeFakeCtx } from "../helpers/fake-ctx";

describe("fix-pass", () => {
  describe("sortFindingsByPriority", () => {
    it("sorts extract-to-atom (P0) before source-rewrite (P2)", () => {
      const findings: DriftFinding[] = [
        { ruleId: "DRIFT-INLINE-STATIC-STYLE", file: "design-system/atoms/card.tsx", message: "inline style" },
        { ruleId: "DRIFT-RAW-PRIMITIVE", file: "design-system/composites/form.tsx", message: "raw primitive" },
      ];
      const sorted = sortFindingsByPriority(findings);
      expect(sorted[0].ruleId).toBe("DRIFT-RAW-PRIMITIVE");
      expect(sorted[1].ruleId).toBe("DRIFT-INLINE-STATIC-STYLE");
    });

    it("sorts source-rewrite (P2) before meta-only (P3)", () => {
      const findings: DriftFinding[] = [
        { ruleId: "DRIFT-META-KIND-MISSING", file: "design-system/atoms/tag.tsx", message: "missing meta" },
        { ruleId: "DRIFT-DS-IMPORTS-FEATURE", file: "design-system/composites/event-card.tsx", message: "domain import" },
      ];
      const sorted = sortFindingsByPriority(findings);
      expect(sorted[0].ruleId).toBe("DRIFT-DS-IMPORTS-FEATURE");
      expect(sorted[1].ruleId).toBe("DRIFT-META-KIND-MISSING");
    });

    it("stable-sorts by file path within same priority", () => {
      const findings: DriftFinding[] = [
        { ruleId: "DRIFT-META-KIND-MISSING", file: "design-system/atoms/chip.tsx", message: "missing meta" },
        { ruleId: "DRIFT-META-KIND-MISSING", file: "design-system/atoms/alert.tsx", message: "missing meta" },
        { ruleId: "DRIFT-META-KIND-MISSING", file: "design-system/atoms/button.tsx", message: "missing meta" },
      ];
      const sorted = sortFindingsByPriority(findings);
      expect(sorted.map(f => f.file)).toEqual([
        "design-system/atoms/alert.tsx",
        "design-system/atoms/button.tsx",
        "design-system/atoms/chip.tsx",
      ]);
    });

    it("sorts full priority chain: P0 → P2 → P3, with report-only rules at the end", () => {
      // DRIFT-MISPLACED is report-only per ADR-0015 — it has no fixer, so its
      // priority is Infinity and it sorts after every fixable rule.
      const findings: DriftFinding[] = [
        { ruleId: "DRIFT-META-KIND-MISSING", file: "design-system/atoms/a.tsx", message: "" },
        { ruleId: "DRIFT-MISPLACED", file: "design-system/atoms/b.tsx", message: "" },
        { ruleId: "DRIFT-INLINE-STATIC-STYLE", file: "design-system/atoms/c.tsx", message: "" },
        { ruleId: "DRIFT-RAW-PRIMITIVE", file: "design-system/atoms/d.tsx", message: "" },
      ];
      const sorted = sortFindingsByPriority(findings);
      expect(sorted.map(f => f.ruleId)).toEqual([
        "DRIFT-RAW-PRIMITIVE",
        "DRIFT-INLINE-STATIC-STYLE",
        "DRIFT-META-KIND-MISSING",
        "DRIFT-MISPLACED",
      ]);
    });
  });

  describe("runFixPass", () => {
    let dir: string;
    beforeEach(async () => { dir = await freshTmpDir(); });
    afterEach(async () => { await cleanup(dir); });

    // PRD #266 Phase A: runFixPass takes the real ctx threaded down from
    // audit-fix, so the synthetic-ctx fabrication (`minimalCtx`) and its
    // `as unknown as ProjectContext` cast are gone from fix-pass.ts.
    it("fix-pass.ts no longer fabricates a synthetic ProjectContext", async () => {
      const source = await readFile(
        join(process.cwd(), "src/lib/fix-pass.ts"),
        "utf8",
      );
      expect(source).not.toMatch(/minimalCtx/);
      expect(source).not.toMatch(/as unknown as ProjectContext/);
    });

    it("applies fixes in priority order", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await mkdir(join(dir, "design-system/composites"), { recursive: true });

      await writeFile(
        join(dir, "design-system/composites/tag.tsx"),
        `export function Tag() { return <span />; }\n`,
      );
      await writeFile(
        join(dir, "design-system/atoms/chip.tsx"),
        `export function Chip() { return <span />; }\n`,
      );

      const findings: DriftFinding[] = [
        {
          ruleId: "DRIFT-META-KIND-MISSING",
          file: "design-system/atoms/chip.tsx",
          message: "missing meta.kind",
        },
        {
          ruleId: "DRIFT-META-KIND-MISSING",
          file: "design-system/composites/tag.tsx",
          message: "missing meta.kind",
        },
      ];

      const result = await runFixPass(makeFakeCtx(dir), findings, {});
      expect(result.aborted).toBe(false);
      expect(result.applied.length).toBeGreaterThan(0);
      expect(result.results.filter(r => r.fixed)).toHaveLength(2);

      const chipContent = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
      expect(chipContent).toContain('kind: "atom"');
      const tagContent = await readFile(join(dir, "design-system/composites/tag.tsx"), "utf8");
      expect(tagContent).toContain('kind: "composite"');
    });

    it("aborts when confirm callback returns false — no files changed", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      const original = `export function Chip() { return <span />; }\n`;
      await writeFile(join(dir, "design-system/atoms/chip.tsx"), original);

      const findings: DriftFinding[] = [{
        ruleId: "DRIFT-META-KIND-MISSING",
        file: "design-system/atoms/chip.tsx",
        message: "missing meta.kind",
      }];

      const result = await runFixPass(makeFakeCtx(dir), findings, {
        confirm: async () => false,
      });

      expect(result.aborted).toBe(true);
      expect(result.applied).toHaveLength(0);
      const content = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
      expect(content).toBe(original);
    });

    it("proceeds when confirm callback returns true", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await writeFile(
        join(dir, "design-system/atoms/chip.tsx"),
        `export function Chip() { return <span />; }\n`,
      );

      const findings: DriftFinding[] = [{
        ruleId: "DRIFT-META-KIND-MISSING",
        file: "design-system/atoms/chip.tsx",
        message: "missing meta.kind",
      }];

      const result = await runFixPass(makeFakeCtx(dir), findings, {
        confirm: async () => true,
      });

      expect(result.aborted).toBe(false);
      expect(result.applied.length).toBeGreaterThan(0);
      const content = await readFile(join(dir, "design-system/atoms/chip.tsx"), "utf8");
      expect(content).toContain('kind: "atom"');
    });

    it("skips non-fixable findings without error", async () => {
      const findings: DriftFinding[] = [{
        ruleId: "DRIFT-PATTERN-NO-SLOTS",
        file: "design-system/patterns/layout.tsx",
        message: "pattern without slots",
      }];

      const result = await runFixPass(makeFakeCtx(dir), findings, {});
      expect(result.aborted).toBe(false);
      expect(result.results).toHaveLength(0);
      expect(result.applied).toHaveLength(0);
    });

    it("DRIFT-MISPLACED is report-only — runFixPass never moves the file (ADR-0015)", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await mkdir(join(dir, "design-system/composites"), { recursive: true });

      // Atom that Path A swaps the raw <input> for
      await writeFile(
        join(dir, "design-system/atoms/input.tsx"),
        `export function Input(props) { return <input {...props} />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      );

      // File that triggers DRIFT-RAW-PRIMITIVE (Path A: raw <input> → <Input>)
      const compositeSource = [
        `export function SearchBar() {`,
        `  return <div><input placeholder="search" /></div>;`,
        `}`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n";
      await writeFile(join(dir, "design-system/composites/search-bar.tsx"), compositeSource);

      // File that triggers DRIFT-MISPLACED (atom in composites/)
      const atomSource = `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`;
      await writeFile(join(dir, "design-system/composites/button.tsx"), atomSource);

      const findings: DriftFinding[] = [
        {
          ruleId: "DRIFT-MISPLACED",
          file: "design-system/composites/button.tsx",
          message: "located in composites/ but classifier says atom",
        },
        {
          ruleId: "DRIFT-RAW-PRIMITIVE",
          file: "design-system/composites/search-bar.tsx",
          message: "raw HTML primitive",
        },
      ];

      const result = await runFixPass(makeFakeCtx(dir), findings, {});

      expect(result.aborted).toBe(false);

      // Verify RAW-PRIMITIVE (P0) ran: raw <input> replaced in place
      const searchBar = await readFile(join(dir, "design-system/composites/search-bar.tsx"), "utf8");
      expect(searchBar).toContain("<Input");

      // Verify DRIFT-MISPLACED did NOT move the file — it's report-only now,
      // the move belongs to `claude-ds classify`.
      const buttonStillInComposites = await stat(join(dir, "design-system/composites/button.tsx")).catch(() => null);
      const buttonInAtoms = await stat(join(dir, "design-system/atoms/button.tsx")).catch(() => null);
      expect(buttonStillInComposites).toBeTruthy();
      expect(buttonInAtoms).toBeNull();

      // The MISPLACED finding produces no FixResult (no fixer registered).
      const fixedResults = result.results.filter(r => r.fixed);
      expect(fixedResults.some(r => r.finding.ruleId === "DRIFT-MISPLACED")).toBe(false);
      expect(fixedResults.some(r => r.finding.ruleId === "DRIFT-RAW-PRIMITIVE")).toBe(true);
    });

    it("returns changes field on FixResult for each fixed finding", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await writeFile(
        join(dir, "design-system/atoms/chip.tsx"),
        `export function Chip() { return <span />; }\n`,
      );

      const findings: DriftFinding[] = [{
        ruleId: "DRIFT-META-KIND-MISSING",
        file: "design-system/atoms/chip.tsx",
        message: "missing meta.kind",
      }];

      const result = await runFixPass(makeFakeCtx(dir), findings, {});
      const fixed = result.results.find(r => r.fixed);
      expect(fixed).toBeDefined();
      expect(fixed!.changes.length).toBeGreaterThan(0);
      expect(fixed!.changes[0].kind).toBe("write");
    });

    it("regenerates barrel exports after fixes apply", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });

      await writeFile(
        join(dir, "design-system/atoms/chip.tsx"),
        `export function Chip() { return <span />; }\n`,
      );
      await writeFile(
        join(dir, "design-system/atoms/button.tsx"),
        `export function Button() { return <button />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      );

      const findings: DriftFinding[] = [{
        ruleId: "DRIFT-META-KIND-MISSING",
        file: "design-system/atoms/chip.tsx",
        message: "missing meta.kind",
      }];

      const result = await runFixPass(makeFakeCtx(dir), findings, {});
      expect(result.aborted).toBe(false);

      // Barrel should be regenerated
      const barrelContent = await readFile(join(dir, "design-system/atoms/index.ts"), "utf8");
      expect(barrelContent).toContain("button");
      expect(barrelContent).toContain("chip");
      expect(barrelContent).not.toContain("showcase");
    });

    it("regenerates manifest.json after fixes apply", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });

      await writeFile(
        join(dir, "design-system/atoms/chip.tsx"),
        `export function Chip() { return <span />; }\n`,
      );

      const findings: DriftFinding[] = [{
        ruleId: "DRIFT-META-KIND-MISSING",
        file: "design-system/atoms/chip.tsx",
        message: "missing meta.kind",
      }];

      const result = await runFixPass(makeFakeCtx(dir), findings, {});
      expect(result.aborted).toBe(false);

      const manifestRaw = await readFile(join(dir, "design-system/manifest.json"), "utf8");
      const manifest = JSON.parse(manifestRaw);
      expect(manifest.components).toHaveLength(1);
      expect(manifest.components[0].name).toBe("chip");
    });

    it("includes finalizer changes in applied array", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });

      await writeFile(
        join(dir, "design-system/atoms/chip.tsx"),
        `export function Chip() { return <span />; }\n`,
      );

      const findings: DriftFinding[] = [{
        ruleId: "DRIFT-META-KIND-MISSING",
        file: "design-system/atoms/chip.tsx",
        message: "missing meta.kind",
      }];

      const result = await runFixPass(makeFakeCtx(dir), findings, {});
      const paths = result.applied.map(c => c.path);
      expect(paths).toContain("design-system/atoms/index.ts");
      expect(paths).toContain("design-system/manifest.json");
    });

    it("does not run finalizer when no fixer changes applied", async () => {
      const findings: DriftFinding[] = [{
        ruleId: "DRIFT-PATTERN-NO-SLOTS",
        file: "design-system/patterns/layout.tsx",
        message: "pattern without slots",
      }];

      const result = await runFixPass(makeFakeCtx(dir), findings, {});
      expect(result.applied).toHaveLength(0);
    });

    it("rolls back all changes and aborts when finalizer change application fails", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      const original = `export function Button() { return <button />; }\n`;
      await writeFile(join(dir, "design-system/atoms/button.tsx"), original);

      const findings: DriftFinding[] = [{
        ruleId: "DRIFT-META-KIND-MISSING",
        file: "design-system/atoms/button.tsx",
        message: "missing meta.kind",
      }];

      // Make design-system/ read-only so finalizer can't write manifest.json.tmp
      await chmod(join(dir, "design-system"), 0o555);

      try {
        const result = await runFixPass(makeFakeCtx(dir), findings, {});
        expect(result.aborted).toBe(true);
        expect(result.applied).toHaveLength(0);
        // Fixer changes should be rolled back
        const content = await readFile(join(dir, "design-system/atoms/button.tsx"), "utf8");
        expect(content).toBe(original);
      } finally {
        await chmod(join(dir, "design-system"), 0o755);
      }
    });

    it("deduplicates Changes for the same path", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });

      // Two findings on the same file — both meta-level (P3)
      await writeFile(
        join(dir, "design-system/atoms/chip.tsx"),
        `export function Chip() { return <span />; }\n`,
      );

      const findings: DriftFinding[] = [
        {
          ruleId: "DRIFT-META-KIND-MISSING",
          file: "design-system/atoms/chip.tsx",
          message: "missing meta.kind",
        },
      ];

      const result = await runFixPass(makeFakeCtx(dir), findings, {});
      // Ensure no duplicate paths in applied changes
      const writePaths = result.applied
        .filter(c => c.kind === "write")
        .map(c => c.path);
      const uniquePaths = new Set(writePaths);
      expect(writePaths.length).toBe(uniquePaths.size);
    });
  });
});
