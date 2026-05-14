import { describe, it, expect } from "vitest";
import { parseExceptions, openCount, gate, ExceptionError } from "../../src/lib/exceptions";

describe("exceptions", () => {
  const today = new Date("2026-05-14T00:00:00Z");
  it("counts only unexpired entries", () => {
    const ex = parseExceptions(JSON.stringify([
      { rule_id: "r1", file: "a.tsx", reason: "x", expiry: "2026-08-01" },
      { rule_id: "r2", file: "b.tsx", reason: "y", expiry: "2026-01-01" },
    ]));
    expect(openCount(ex, today)).toBe(1);
  });
  it("threshold gate refuses above threshold", () => {
    const ex = parseExceptions(JSON.stringify(
      Array.from({ length: 11 }).map((_, i) => ({ rule_id: `r${i}`, file: `f${i}`, reason: "x", expiry: "2026-12-01" }))
    ));
    expect(() => gate(ex, 10, today)).toThrow(ExceptionError);
  });
});
