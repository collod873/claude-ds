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

  it("non-TTY mode picks safe default instead of deferring interactive findings", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });

    await writeFile(
      join(dir, "design-system/composites/toolbar.tsx"),
      [
        `export function Toolbar() { return <div><button className="ghost outline">Click</button></div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n",
    );
    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      [
        `import { cva } from "class-variance-authority";`,
        `const bv = cva("btn", { variants: { variant: { default: "d", ghost: "g", outline: "o" } }, defaultVariants: { variant: "default" } });`,
        `export function Button(props: any) { return <button {...props} />; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
      ].join("\n") + "\n",
    );

    setNonTTY();

    await auditCmd({ fix: true, pack: "next-react", cwd: dir });

    // Raw primitive should be fixed (first option picked), not deferred
    const toolbar = await readFile(join(dir, "design-system/composites/toolbar.tsx"), "utf8");
    expect(toolbar).toContain("<Button");
    expect(toolbar).not.toContain("<button");
  });

  it("no auto-deferred exceptions when non-TTY prompt picks safe defaults", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });

    await writeFile(
      join(dir, "design-system/composites/form.tsx"),
      [
        `export function Form() { return <form><button className="ghost outline" type="submit">Go</button></form>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n",
    );
    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      [
        `import { cva } from "class-variance-authority";`,
        `const bv = cva("btn", { variants: { variant: { default: "d", ghost: "g", outline: "o" } }, defaultVariants: { variant: "default" } });`,
        `export function Button(props: any) { return <button {...props} />; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
      ].join("\n") + "\n",
    );

    setNonTTY();

    await auditCmd({ fix: true, pack: "next-react", cwd: dir });

    // The raw primitive should be fixed, not deferred — no exceptions.json needed
    const form = await readFile(join(dir, "design-system/composites/form.tsx"), "utf8");
    expect(form).toContain("<Button");
    expect(form).not.toContain("<button");
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

  it("outputs fix summary with all-fixed counts when non-TTY picks defaults", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });

    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      [
        `export function Button(props: any) { return <button {...props} />; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
      ].join("\n") + "\n",
    );
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
  });

  it("fixes interactive findings in non-TTY mode instead of deferring them", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });

    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      [
        `export function Button(props: any) { return <button {...props} />; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
      ].join("\n") + "\n",
    );
    await writeFile(
      join(dir, "design-system/composites/toolbar.tsx"),
      [
        `export function Toolbar() { return <div><button>X</button></div>; }`,
        `export const meta = { kind: "composite" as const, examples: [] };`,
      ].join("\n") + "\n",
    );

    setNonTTY();

    await auditCmd({ fix: true, pack: "next-react", cwd: dir });

    // Raw primitive should be fixed (not deferred)
    const toolbar = await readFile(join(dir, "design-system/composites/toolbar.tsx"), "utf8");
    expect(toolbar).toContain("<Button");
    expect(toolbar).not.toContain("<button>");

    // No auto-deferred exceptions for DRIFT-RAW-PRIMITIVE
    const calls = vi.mocked(info).mock.calls.map(c => String(c[0]));
    expect(calls.some(c => c.includes("auto-deferred"))).toBe(false);
  });
});
