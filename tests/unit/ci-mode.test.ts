import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

vi.mock("../../src/lib/log.js", () => ({
  info: vi.fn(),
  err: vi.fn(),
}));

import { auditCmd } from "../../src/commands/audit";
import { info } from "../../src/lib/log";

describe("non-TTY CI mode", () => {
  let dir: string;
  let originalStdoutIsTTY: boolean | undefined;
  let originalStdinIsTTY: boolean | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await freshTmpDir();
    originalStdoutIsTTY = process.stdout.isTTY;
    originalStdinIsTTY = process.stdin.isTTY;
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    vi.mocked(info).mockReset();
  });

  afterEach(async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY,
      writable: true,
      configurable: true,
    });
    exitSpy.mockRestore();
    await cleanup(dir);
  });

  function setNonTTY() {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
  }

  it("auto-defers interactive findings to exceptions.json in non-TTY mode", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });

    await writeFile(
      join(dir, "design-system/composites/toolbar.tsx"),
      [
        `export function Toolbar() { return <div><button>Click</button></div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n",
    );
    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      [
        `export function Button(props: any) { return <button {...props} />; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
      ].join("\n") + "\n",
    );

    setNonTTY();

    await auditCmd({ fix: true, pack: "next-react", cwd: dir });

    expect(exitSpy).toHaveBeenCalledWith(1);

    const exceptionsRaw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    const exceptions = JSON.parse(exceptionsRaw);
    expect(exceptions.exceptions.length).toBeGreaterThan(0);
    const deferred = exceptions.exceptions.find(
      (e: any) => e.rule === "DRIFT-RAW-PRIMITIVE",
    );
    expect(deferred).toBeDefined();
    expect(deferred.reason).toBe("auto-deferred: no TTY");
  });

  it("deferred exceptions have no issue link", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });

    await writeFile(
      join(dir, "design-system/composites/form.tsx"),
      [
        `export function Form() { return <form><button type="submit">Go</button></form>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n",
    );
    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      [
        `export function Button(props: any) { return <button {...props} />; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
      ].join("\n") + "\n",
    );

    setNonTTY();

    await auditCmd({ fix: true, pack: "next-react", cwd: dir });

    const exceptionsRaw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    const exceptions = JSON.parse(exceptionsRaw);
    for (const ex of exceptions.exceptions) {
      if (ex.reason === "auto-deferred: no TTY") {
        expect(ex).not.toHaveProperty("issue");
      }
    }
  });

  it("exits 0 when all findings are deterministic and fixed in non-TTY", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });

    await writeFile(
      join(dir, "design-system/atoms/chip.tsx"),
      `export function Chip() { return <span />; }\n`,
    );

    // Need .claude-ds.json with meta_kind_strict for DRIFT-META-KIND-MISSING to fire
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      packVersion: "v0.0.1",
      pack: "next-react",
      mode: "warn",
      meta_kind_strict: true,
    }));

    setNonTTY();

    await auditCmd({ fix: true, cwd: dir });

    // Should NOT exit 1 — all findings were deterministically fixed
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it("outputs summary distinguishing fixed vs deferred counts", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });

    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      [
        `export function Button(props: any) { return <button {...props} />; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
      ].join("\n") + "\n",
    );
    // A composite with raw <button> triggers DRIFT-RAW-PRIMITIVE (interactive, will defer)
    await writeFile(
      join(dir, "design-system/composites/toolbar.tsx"),
      [
        `export function Toolbar() { return <div><button>X</button></div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n",
    );

    setNonTTY();

    await auditCmd({ fix: true, pack: "next-react", cwd: dir });

    const calls = vi.mocked(info).mock.calls.map(c => String(c[0]));
    const summaryLine = calls.find(c => c.includes("fix summary:"));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toMatch(/\d+ fixed/);
    expect(summaryLine).toMatch(/\d+ deferred/);
  });

  it("exit code is 1 when deferred findings exist even if some were fixed", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });

    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      [
        `export function Button(props: any) { return <button {...props} />; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
      ].join("\n") + "\n",
    );
    // Composite: raw primitive will defer (interactive), meta fix is deterministic
    await writeFile(
      join(dir, "design-system/composites/toolbar.tsx"),
      [
        `export function Toolbar() { return <div><button>X</button></div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n",
    );

    setNonTTY();

    await auditCmd({ fix: true, pack: "next-react", cwd: dir });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
