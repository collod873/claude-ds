/**
 * PRD #266 Phase C step 2 — command-level pre-pass + determinism of
 * `fixerAsOperation(f).plan(ctx)`.
 *
 * What the pre-pass guarantees:
 *   - Non-TTY `audit --fix` never invokes a prompt; every interactive finding
 *     lands in `exceptions.json` with `reason: "auto-deferred: no TTY"` BEFORE
 *     any drift-fixer Op is constructed.
 *   - Per-finding answers (and the `"defer"` sentinel) live on
 *     `ctx.decisions.fixerChoices`, so the fixer is a pure function of
 *     `(finding, ctx)`. Running the same Op twice over the same ctx returns
 *     equal `Change[]` — the literal statement that `plan(ctx)` is pure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { makeFakeCtx } from "../helpers/fake-ctx";
import { fixerAsOperation } from "../../src/lib/fix-pass";
import { findingKey, type DriftFinding } from "../../src/lib/drift/index.js";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

vi.mock("../../src/lib/log.js", () => ({
  info: vi.fn(),
  err: vi.fn(),
  printNextStep: vi.fn(),
  detectBuildCommand: vi.fn().mockResolvedValue("npm run build"),
}));

import { auditCmd } from "../../src/commands/audit";
import { makeTtyPrompt } from "../../src/lib/drift/prompt.js";

describe("audit-fix command-level pre-pass (PRD #266 Phase C step 2)", () => {
  let dir: string;
  let originalStdoutIsTTY: boolean | undefined;
  let originalStdinIsTTY: boolean | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await freshTmpDir();
    originalStdoutIsTTY = process.stdout.isTTY;
    originalStdinIsTTY = process.stdin.isTTY;
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY, writable: true, configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY, writable: true, configurable: true,
    });
    exitSpy.mockRestore();
    await cleanup(dir);
  });

  function setNonTTY() {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false, writable: true, configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: false, writable: true, configurable: true,
    });
  }

  describe("non-TTY pre-pass routes interactive findings to exceptions.json", () => {
    /**
     * Composite imports a symbol from `lib/api/` whose source file has its own
     * `features/auth/` domain dep. `canExtract` is false, `canConvertToProp`
     * is true → describeDecisions emits a `convert:...` decision point. In
     * non-TTY the pre-pass records `"defer"` for every decision; the finding
     * lands in `exceptions.json` and the fix never runs.
     */
    async function scaffoldInteractiveDsImports() {
      await writeFile(
        join(dir, ".claude-ds.json"),
        JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn" }),
      );
      await mkdir(join(dir, "design-system/composites"), { recursive: true });
      await mkdir(join(dir, "lib/api"), { recursive: true });
      await mkdir(join(dir, "features/auth"), { recursive: true });

      await writeFile(join(dir, "features/auth/session.ts"),
        `export function getSession() { return { user: "x" }; }\n`);
      await writeFile(join(dir, "lib/api/client.ts"), [
        `import { getSession } from "../../features/auth/session";`,
        `export function apiClient() { return getSession(); }`,
        ``,
      ].join("\n"));
      await writeFile(join(dir, "design-system/composites/user-badge.tsx"), [
        `import { apiClient } from "../../lib/api/client";`,
        `export function UserBadge() { return <div>{apiClient()}</div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
        ``,
      ].join("\n"));
    }

    it("DRIFT-DS-IMPORTS-FEATURE: auto-defers to exceptions.json in non-TTY mode", async () => {
      await scaffoldInteractiveDsImports();
      setNonTTY();

      // Sanity: no exceptions before the run.
      await expect(
        readFile(join(dir, "design-system/exceptions.json"), "utf8"),
      ).rejects.toThrow();

      await auditCmd({ fix: true, cwd: dir });

      const ex = JSON.parse(
        await readFile(join(dir, "design-system/exceptions.json"), "utf8"),
      );
      const autoDeferred = ex.exceptions.filter(
        (e: { rule: string; reason?: string }) =>
          e.rule === "DRIFT-DS-IMPORTS-FEATURE" && e.reason === "auto-deferred: no TTY",
      );
      expect(autoDeferred).toHaveLength(1);
      expect(autoDeferred[0].path).toBe("design-system/composites/user-badge.tsx");

      // The fix never ran — the original import is still there.
      const composite = await readFile(
        join(dir, "design-system/composites/user-badge.tsx"), "utf8",
      );
      expect(composite).toContain("lib/api/client");
    });

    it("DRIFT-INLINE-STATIC-STYLE: equidistant-token finding auto-defers in non-TTY", async () => {
      // Two tokens equidistant from `padding: 12` → the only decision point
      // for this finding is `token-tie:padding:12`. Non-TTY → "defer" → finding
      // auto-deferred to exceptions.json; the inline style stays.
      await writeFile(
        join(dir, ".claude-ds.json"),
        JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn" }),
      );
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await writeFile(join(dir, "design-system/tokens.json"), JSON.stringify({
        spacing: { 2: "8", 4: "16" },
      }));
      await writeFile(join(dir, "design-system/atoms/card.tsx"), [
        `export function Card() { return <div style={{ padding: 12 }}>x</div>; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
        ``,
      ].join("\n"));

      setNonTTY();
      await auditCmd({ fix: true, cwd: dir });

      const ex = JSON.parse(
        await readFile(join(dir, "design-system/exceptions.json"), "utf8"),
      );
      const auto = ex.exceptions.filter(
        (e: { rule: string; reason?: string }) =>
          e.rule === "DRIFT-INLINE-STATIC-STYLE" && e.reason === "auto-deferred: no TTY",
      );
      expect(auto).toHaveLength(1);

      // Style was not rewritten — the deferred finding was never planned.
      const card = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
      expect(card).toContain("padding: 12");
      expect(card).not.toContain("spacing-");
    });

    it("never constructs the TTY prompt module's readline interface in non-TTY mode", async () => {
      // makeTtyPrompt() returns a function that opens a readline interface
      // when invoked. The pre-pass only constructs that function path when
      // `isTTY`. We verify by spying on the export — non-TTY should not call
      // it.
      const promptModule = await import("../../src/lib/drift/prompt.js");
      const spy = vi.spyOn(promptModule, "makeTtyPrompt");
      try {
        await scaffoldInteractiveDsImports();
        setNonTTY();
        await auditCmd({ fix: true, cwd: dir });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

  });

  // Smoke test that the prompt module hasn't lost the TTY path — used by the
  // pre-pass when isTTY is true. (Functional TTY coverage is in the audit*
  // integration tests, which run the real auditCmd.)
  describe("TTY prompt construction still works", () => {
    it("makeTtyPrompt returns a callable", () => {
      expect(typeof makeTtyPrompt()).toBe("function");
    });
  });

  describe("plan(ctx) determinism", () => {
    /**
     * The promise this PRD exists to enforce: `fixerAsOperation(f).plan(ctx)`
     * returns equal `Change[]` on two consecutive invocations with the same
     * ctx (including `ctx.decisions.fixerChoices`). With the prompt-in-plan
     * seam gone, the only inputs to fix() are `finding` and `ctx` — same
     * inputs ⇒ same outputs.
     */
    it("DRIFT-META-KIND-MISSING plan is deterministic over the same ctx", async () => {
      const cwd = await freshTmpDir();
      try {
        await mkdir(join(cwd, "design-system/atoms"), { recursive: true });
        await writeFile(
          join(cwd, "design-system/atoms/chip.tsx"),
          `export function Chip() { return <span />; }\n`,
        );
        const finding: DriftFinding = {
          ruleId: "DRIFT-META-KIND-MISSING",
          file: "design-system/atoms/chip.tsx",
          message: "missing meta.kind",
        };
        const ctx = makeFakeCtx(cwd);
        const a = await fixerAsOperation(finding).plan(ctx);
        const b = await fixerAsOperation(finding).plan(ctx);
        expect(a.map(c => ({ ...c, before: undefined, after: undefined }))).toEqual(
          b.map(c => ({ ...c, before: undefined, after: undefined })),
        );
        // Bytes equal too — `plan` only reads, so the writes are identical.
        const aWrite = a.find(c => c.kind === "write");
        const bWrite = b.find(c => c.kind === "write");
        expect(aWrite && bWrite && aWrite.kind === "write" && bWrite.kind === "write")
          .toBeTruthy();
        if (aWrite?.kind === "write" && bWrite?.kind === "write") {
          expect(aWrite.after.equals(bWrite.after)).toBe(true);
        }
      } finally {
        await cleanup(cwd);
      }
    });

    it("DRIFT-INLINE-STATIC-STYLE plan is deterministic over the same ctx.decisions.fixerChoices", async () => {
      const cwd = await freshTmpDir();
      try {
        await mkdir(join(cwd, "design-system/atoms"), { recursive: true });
        await writeFile(join(cwd, "design-system/tokens.json"), JSON.stringify({
          spacing: { 2: "8", 4: "16" },
        }));
        await writeFile(
          join(cwd, "design-system/atoms/card.tsx"),
          [
            `export function Card() { return <div style={{ padding: 12 }}>x</div>; }`,
            `export const meta = { kind: "atom" as const, examples: [] };`,
          ].join("\n") + "\n",
        );

        const finding: DriftFinding = {
          ruleId: "DRIFT-INLINE-STATIC-STYLE",
          file: "design-system/atoms/card.tsx",
          message: "inline style",
        };
        // Equidistant-token answer: 0 = first nearest token (spacing-2).
        const ctx = makeFakeCtx(cwd, {
          decisions: {
            fixerChoices: {
              [findingKey(finding)]: { "token-tie:padding:12": 0 },
            },
          },
        });

        const a = await fixerAsOperation(finding).plan(ctx);
        const b = await fixerAsOperation(finding).plan(ctx);

        const aWrite = a.find(c => c.kind === "write");
        const bWrite = b.find(c => c.kind === "write");
        expect(aWrite?.kind).toBe("write");
        expect(bWrite?.kind).toBe("write");
        if (aWrite?.kind === "write" && bWrite?.kind === "write") {
          expect(aWrite.after.equals(bWrite.after)).toBe(true);
        }
      } finally {
        await cleanup(cwd);
      }
    });
  });
});
