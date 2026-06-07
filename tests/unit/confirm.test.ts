/**
 * Issue #364 — `confirm()` must fail loud on non-TTY rather than silently
 * resolving to "no" with exit 0. Three regressions are pinned here:
 *
 *   1. Non-TTY entry → write to stderr → process.exit(3).
 *      Scripts can distinguish "no user available" from a user choosing "no".
 *   2. Aborted message goes to stderr, never stdout. Scripts grepping stderr
 *      for failures saw clean output before.
 *   3. The "aborted" path on a real "n" answer carries a non-zero exit too —
 *      cancellation is not "successful no-op".
 *
 * confirm() can shell out to readline; the tests here mock `process.stdin`
 * (TTY flag + a readable stream) and `process.exit` so behavior is exercised
 * without spawning the CLI.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { confirm } from "../../src/lib/log.js";

class ExitError extends Error {
  constructor(public exitCode: number) {
    super(`exit(${exitCode})`);
  }
}

interface Captured {
  stdout: string;
  stderr: string;
  exit: number | null;
}

function setup(stdin: { isTTY: boolean; data?: string }): {
  captured: Captured;
  restore: () => void;
} {
  const captured: Captured = { stdout: "", stderr: "", exit: null };

  const origExit = process.exit;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origConsoleError = console.error;
  const origStdinDesc = Object.getOwnPropertyDescriptor(process, "stdin");

  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured.stdout += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    const cb = rest.find((r) => typeof r === "function") as ((err?: Error) => void) | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured.stderr += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    const cb = rest.find((r) => typeof r === "function") as ((err?: Error) => void) | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stderr.write;
  console.error = (...args: unknown[]) => {
    captured.stderr += args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n";
  };

  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    captured.exit = code ?? 0;
    throw new ExitError(code ?? 0);
  }) as never;

  const fake = Readable.from(stdin.data ?? "") as Readable & { isTTY?: boolean };
  fake.isTTY = stdin.isTTY;
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });

  return {
    captured,
    restore() {
      process.stdout.write = origStdoutWrite as typeof process.stdout.write;
      process.stderr.write = origStderrWrite as typeof process.stderr.write;
      console.error = origConsoleError;
      (process as unknown as { exit: typeof origExit }).exit = origExit;
      if (origStdinDesc) Object.defineProperty(process, "stdin", origStdinDesc);
    },
  };
}

describe("confirm() — non-TTY fail-loud (#364)", () => {
  let teardown: (() => void) | null = null;

  beforeEach(() => { teardown = null; });
  afterEach(() => { teardown?.(); });

  it("exits non-zero with a stderr message when stdin is non-TTY and no answer is supplied", async () => {
    const { captured, restore } = setup({ isTTY: false });
    teardown = restore;

    await expect(confirm("Apply the change?")).rejects.toBeInstanceOf(ExitError);

    expect(captured.exit).toBe(3);
    expect(captured.stderr).toMatch(/non-TTY/i);
    expect(captured.stderr).toMatch(/--yes/);
    // The legacy "aborted" line was on stdout; the new fail-loud must not
    // bleed onto stdout where scripts grepping stderr would miss it.
    expect(captured.stdout).toBe("");
  });

  it("does not silently default to 'no' on closed stdin", async () => {
    const { captured, restore } = setup({ isTTY: false, data: "" });
    teardown = restore;

    await expect(confirm("Re-apply drifted migrations?")).rejects.toBeInstanceOf(ExitError);
    expect(captured.exit).toBe(3);
    expect(captured.stderr).not.toBe("");
  });
});
