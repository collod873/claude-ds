/**
 * Issue #370 — `info()` / `err()` in src/lib/log.ts used to emit plain
 * `console.log` / `console.error`, leaving the five unexercised commands
 * (`version`, `migrate`, `migrate-layout`, `reconform`, `enforce`) without
 * the colored phase headers / verdict lines the dashboard and front door
 * already render via the TTY adapter.
 *
 * The fix exposes a tiny `colors()` accessor on `lib/log.ts` that returns the
 * picocolors-backed adapter on a real TTY and the identity adapter otherwise.
 * Commands wrap their phase markers / verdict lines through it; the byte
 * stream off-TTY (the agent surface) stays identical.
 */
import { afterEach, describe, expect, it } from "vitest";
import { colors } from "../../src/lib/log.js";
import { identityColor } from "../../src/lib/render/color.js";

describe("colors() — TTY-gated adapter accessor (#370)", () => {
  const original = process.stdout.isTTY;
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: original,
      writable: true,
      configurable: true,
    });
  });

  it("returns the identity adapter when stdout is not a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    expect(colors()).toBe(identityColor);
  });

  it("returns a non-identity adapter when stdout is a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    const c = colors();
    expect(c).not.toBe(identityColor);
    expect(typeof c.green).toBe("function");
    expect(typeof c.red).toBe("function");
    expect(typeof c.cyan).toBe("function");
    expect(typeof c.bold).toBe("function");
    expect(typeof c.dim).toBe("function");
  });

  it("identity adapter pass-through keeps the non-TTY byte stream unchanged", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    const c = colors();
    expect(c.green("ok")).toBe("ok");
    expect(c.red("fail")).toBe("fail");
    expect(c.cyan("phase")).toBe("phase");
    expect(c.bold("bold")).toBe("bold");
    expect(c.dim("dim")).toBe("dim");
  });
});
