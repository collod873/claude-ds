/**
 * Functions-first contract (issue #437 / ADR-0018, PRD #468).
 *
 * The four loop members (`sync`, `upgrade`, `classify`, `audit`) return a
 * `CommandResult` instead of driving their verdict through `process.exit` +
 * global stdout. This pins the load-bearing invariant the deleted
 * `runWithoutExit` monkeypatch used to compensate for: a loop member NEVER
 * calls `process.exit` — it returns a typed result the caller maps. Here we
 * trap `process.exit` so any stray call fails the test loudly, and assert the
 * returned `{ outcome, exitCode }` on a representative error path for each.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { syncCmd } from "../../src/commands/sync";
import { upgradeCmd } from "../../src/commands/upgrade";
import { classifyCmd } from "../../src/commands/classify";
import { auditCmd } from "../../src/commands/audit";

// Silence the commands' info()/err() chatter so the test output stays clean;
// we assert on the returned value, not on stdout.
vi.mock("../../src/lib/log.js", async (orig) => {
  const actual = await orig<typeof import("../../src/lib/log.js")>();
  return { ...actual, info: vi.fn(), err: vi.fn() };
});

describe("CommandResult — loop members return, never process.exit (#437)", () => {
  let dir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await freshTmpDir();
    // Trap process.exit: a converted loop member must never reach it.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called — a loop member must return a CommandResult`);
    }) as never);
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    await cleanup(dir);
  });

  it("syncCmd returns an error result (no .claude-ds.json) without exiting", async () => {
    const result = await syncCmd({ cwd: dir });
    expect(result).toEqual({ outcome: "error", exitCode: 2 });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("upgradeCmd returns an error result (no .claude-ds.json) without exiting", async () => {
    const result = await upgradeCmd({ cwd: dir });
    expect(result).toEqual({ outcome: "error", exitCode: 2 });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("classifyCmd returns an error result (no .claude-ds.json) without exiting", async () => {
    const result = await classifyCmd({ cwd: dir });
    expect(result).toEqual({ outcome: "error", exitCode: 2 });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("auditCmd returns an error result (no --pack, no config) without exiting", async () => {
    const result = await auditCmd({ cwd: dir });
    expect(result).toEqual({ outcome: "error", exitCode: 2 });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("a clean loop member returns success with a caller-owned breadcrumb hint", async () => {
    // A bare `classify` on an adopted-but-empty tree settles to a no-op and
    // returns the `→ Next` breadcrumb for the CLI to render — the driver
    // discards it, so nothing prints on the loop path.
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn" }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });

    const result = await classifyCmd({ cwd: dir, yes: true });
    expect(result.outcome).toBe("success");
    expect(result.exitCode).toBe(0);
    expect(result.nextStep).toEqual({ command: "classify", ctx: {} });
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
