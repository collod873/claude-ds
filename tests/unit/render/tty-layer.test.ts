/**
 * PRD #325 sub-issue #330 — the TTY layer is intentionally thin: `printLines`
 * writes the pure renderers' output to stdout, and `loadColorAdapter` picks
 * `picocolors` vs. `identityColor` based on `isTTY()`. A smoke test plus the
 * snapshot tests for the pure renderers is the coverage the issue specifies
 * — no pty harness needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadColorAdapter,
  printLines,
} from "../../../src/lib/render/tty-layer.js";
import { identityColor } from "../../../src/lib/render/index.js";

describe("printLines", () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured: string[] = [];

  beforeEach(() => {
    captured = [];
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it("writes one trailing-newline-terminated string per call", () => {
    printLines(["a", "b", "c"]);
    expect(captured.join("")).toBe("a\nb\nc\n");
  });

  it("is a no-op for an empty line array", () => {
    printLines([]);
    expect(captured).toEqual([]);
  });
});

describe("loadColorAdapter", () => {
  const original = process.stdout.isTTY;
  afterEach(() => {
    process.stdout.isTTY = original;
  });

  it("returns identityColor on the non-TTY path", () => {
    process.stdout.isTTY = false;
    expect(loadColorAdapter()).toBe(identityColor);
  });

  it("returns a non-identity adapter on the TTY path", () => {
    process.stdout.isTTY = true;
    const adapter = loadColorAdapter();
    expect(adapter).not.toBe(identityColor);
    // `picocolors` may strip when NO_COLOR is set or it can't detect a real
    // terminal; the only invariant the smoke test pins is the wiring — the
    // adapter is the TTY one, not the identity one.
    expect(typeof adapter.green).toBe("function");
  });
});
