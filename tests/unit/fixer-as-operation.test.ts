import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change } from "../../src/lib/operation";

vi.mock("../../src/lib/drift/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/drift/index.js")>();
  return {
    ...original,
    getFixer: vi.fn(original.getFixer),
  };
});

import { runFixPass } from "../../src/lib/fix-pass";
import { getFixer } from "../../src/lib/drift/index.js";
import type { DriftFinding } from "../../src/lib/drift/index.js";
import { makeFakeCtx } from "../helpers/fake-ctx";

const mockedGetFixer = vi.mocked(getFixer);

describe("fix-pass: fixerAsOperation wrapper (#224)", () => {
  it("fix-pass.ts source does not import node:fs/promises", async () => {
    const source = await readFile(
      join(process.cwd(), "src/lib/fix-pass.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']node:fs\/promises["']/);
  });

  describe("invalid fixer output yields abort Change; other findings still apply", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await freshTmpDir();
      mockedGetFixer.mockReset();
    });
    afterEach(async () => {
      mockedGetFixer.mockRestore();
      await cleanup(dir);
    });

    it("invalid output is skipped (abort), valid output still applies", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      const validSourceA = `export function Alpha() { return <span />; }\n`;
      const validSourceB = `export function Beta() { return <span />; }\n`;
      const brokenOutputA = `export function Alpha( { return <span />; }\n`;
      const validOutputB = `export function Beta() { return <span />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`;

      await writeFile(join(dir, "design-system/atoms/alpha.tsx"), validSourceA);
      await writeFile(join(dir, "design-system/atoms/beta.tsx"), validSourceB);

      mockedGetFixer.mockReturnValue(async (finding: DriftFinding) => {
        const before = finding.file.endsWith("alpha.tsx")
          ? validSourceA
          : validSourceB;
        const after = finding.file.endsWith("alpha.tsx")
          ? brokenOutputA
          : validOutputB;
        return {
          finding,
          fixed: true,
          message: "applied",
          changes: [{
            kind: "write" as const,
            path: finding.file,
            before: Buffer.from(before),
            after: Buffer.from(after),
          }],
        };
      });

      const findings: DriftFinding[] = [
        {
          ruleId: "DRIFT-META-KIND-MISSING",
          file: "design-system/atoms/alpha.tsx",
          message: "missing meta.kind",
        },
        {
          ruleId: "DRIFT-META-KIND-MISSING",
          file: "design-system/atoms/beta.tsx",
          message: "missing meta.kind",
        },
      ];

      const result = await runFixPass(makeFakeCtx(dir), findings, {});

      expect(result.aborted).toBe(false);

      const alphaResult = result.results.find(
        r => r.finding.file === "design-system/atoms/alpha.tsx",
      );
      const betaResult = result.results.find(
        r => r.finding.file === "design-system/atoms/beta.tsx",
      );

      expect(alphaResult).toBeDefined();
      expect(alphaResult!.fixed).toBe(false);
      expect(alphaResult!.message).toMatch(/DRIFT-META-KIND-MISSING/);

      expect(betaResult).toBeDefined();
      expect(betaResult!.fixed).toBe(true);

      // Alpha's file content is untouched
      const alphaContent = await readFile(
        join(dir, "design-system/atoms/alpha.tsx"),
        "utf8",
      );
      expect(alphaContent).toBe(validSourceA);

      // Beta's file was actually written
      const betaContent = await readFile(
        join(dir, "design-system/atoms/beta.tsx"),
        "utf8",
      );
      expect(betaContent).toBe(validOutputB);
    });

    it("aborted finding emits an abort Change carrying the validation reason", async () => {
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      const valid = `export function Chip() { return <span />; }\n`;
      const broken = `export function Chip( { return <span />; }\n`;
      await writeFile(join(dir, "design-system/atoms/chip.tsx"), valid);

      const fixer = vi.fn(async (finding: DriftFinding) => ({
        finding,
        fixed: true,
        message: "applied",
        changes: [{
          kind: "write" as const,
          path: finding.file,
          before: Buffer.from(valid),
          after: Buffer.from(broken),
        }],
      }));
      mockedGetFixer.mockReturnValue(fixer);

      // We need to spy via the lib/operation Change types — assert the
      // wrapper plans an `abort` change rather than the bad write. Easiest
      // way is to import fixerAsOperation directly and inspect plan().
      const { fixerAsOperation } = await import("../../src/lib/fix-pass");

      const finding: DriftFinding = {
        ruleId: "DRIFT-META-KIND-MISSING",
        file: "design-system/atoms/chip.tsx",
        message: "missing meta.kind",
      };
      const op = fixerAsOperation(finding, {});
      const ctx = { cwd: dir } as any;
      const changes: Change[] = await op.plan(ctx);
      expect(changes).toHaveLength(1);
      expect(changes[0].kind).toBe("abort");
      if (changes[0].kind === "abort") {
        expect(changes[0].reason).toMatch(/DRIFT-META-KIND-MISSING/);
        expect(changes[0].path).toBe("design-system/atoms/chip.tsx");
      }
    });
  });
});
