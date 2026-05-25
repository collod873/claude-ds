import { describe, it, expect, vi } from "vitest";
import { parseExceptions, openCount, gate, lintExceptions, ExceptionError, type IssueChecker } from "../../src/lib/exceptions";

describe("exceptions — parseExceptions", () => {
  it("accepts a valid entry with rule, path, and issue", () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/foo.tsx", issue: "#42", reason: "tracked workaround" },
      ],
    }));
    expect(ex).toHaveLength(1);
    expect(ex[0].rule).toBe("DRIFT-MISPLACED");
    expect(ex[0].path).toBe("design-system/atoms/foo.tsx");
    expect(ex[0].issue).toBe("#42");
  });

  it("accepts valid entry with issue as full URL", () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISCLASSIFIED-ATOM", path: "design-system/atoms/bar.tsx", issue: "https://github.com/owner/repo/issues/7" },
      ],
    }));
    expect(ex[0].issue).toMatch(/^https?:/);
  });

  it("accepts empty exceptions array", () => {
    const ex = parseExceptions(JSON.stringify({ exceptions: [] }));
    expect(ex).toHaveLength(0);
  });

  it("accepts entry without reason (reason is optional)", () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-DS-IMPORTS-FEATURE", path: "design-system/atoms/baz.tsx", issue: "#10" },
      ],
    }));
    expect(ex).toHaveLength(1);
  });

  it("accepts entry without issue (issue is optional at parse time, warned by lint)", () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/baz.tsx" },
      ],
    }));
    expect(ex).toHaveLength(1);
    expect(ex[0].issue).toBeUndefined();
  });

  it("accepts entry with permanent:true and round-trips the field", () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/AppShell.tsx", permanent: true, reason: "app chrome singleton" },
      ],
    }));
    expect(ex).toHaveLength(1);
    expect(ex[0].permanent).toBe(true);
    expect(ex[0].reason).toBe("app chrome singleton");
  });

  it("permanent defaults to undefined when not present", () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "a.tsx", issue: "#1" },
      ],
    }));
    expect(ex[0].permanent).toBeUndefined();
  });

  it("errors on unknown rule ID with a clear message naming the bad ID", () => {
    try {
      parseExceptions(JSON.stringify({
        exceptions: [
          { rule: "NOT-A-RULE", path: "design-system/atoms/button.tsx", issue: "#1" },
        ],
      }));
      expect.fail("expected ExceptionError");
    } catch (e) {
      expect(e).toBeInstanceOf(ExceptionError);
      expect((e as Error).message).toMatch(/unknown rule ID/i);
      expect((e as Error).message).toContain("NOT-A-RULE");
    }
  });

  it("errors on old-style rule ID (TOKEN-001 is not a DriftRuleId)", () => {
    expect(() =>
      parseExceptions(JSON.stringify({
        exceptions: [
          { rule: "TOKEN-001", path: "design-system/atoms/button.tsx", issue: "#1" },
        ],
      }))
    ).toThrow(ExceptionError);
  });

  it("errors on missing path field", () => {
    expect(() =>
      parseExceptions(JSON.stringify({
        exceptions: [{ rule: "DRIFT-MISPLACED", issue: "#1" }],
      }))
    ).toThrow(ExceptionError);
  });

  it("errors on missing rule field", () => {
    expect(() =>
      parseExceptions(JSON.stringify({
        exceptions: [{ path: "design-system/atoms/button.tsx", issue: "#1" }],
      }))
    ).toThrow(ExceptionError);
  });

  it("rejects bare array shape", () => {
    expect(() =>
      parseExceptions(JSON.stringify([
        { rule: "DRIFT-MISPLACED", path: "a.tsx", issue: "#1" },
      ]))
    ).toThrow(ExceptionError);
  });

  it("rejects non-array exceptions value", () => {
    expect(() =>
      parseExceptions(JSON.stringify({ exceptions: "bad" }))
    ).toThrow(ExceptionError);
  });
});

describe("exceptions — openCount and gate", () => {
  it("counts all entries", () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "a.tsx", issue: "#1" },
        { rule: "DRIFT-MISCLASSIFIED-ATOM", path: "b.tsx", issue: "#2" },
      ],
    }));
    expect(openCount(ex)).toBe(2);
  });

  it("returns 0 for empty list", () => {
    expect(openCount([])).toBe(0);
  });

  it("gate passes when count is at or below threshold", () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "a.tsx", issue: "#1" },
      ],
    }));
    expect(() => gate(ex, 1)).not.toThrow();
    expect(() => gate(ex, 5)).not.toThrow();
  });

  it("gate throws ExceptionError when count exceeds threshold", () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: Array.from({ length: 11 }, (_, i) => ({
        rule: "DRIFT-MISPLACED",
        path: `f${i}.tsx`,
        issue: `#${i + 1}`,
      })),
    }));
    expect(() => gate(ex, 10)).toThrow(ExceptionError);
  });
});

describe("lintExceptions", () => {
  it("returns no warnings for entry with an open issue", async () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/foo.tsx", issue: "#42" },
      ],
    }));
    const checker: IssueChecker = vi.fn().mockResolvedValue("open");
    const warnings = await lintExceptions(ex, checker);
    expect(warnings).toHaveLength(0);
  });

  it("warns when issue field is missing", async () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/foo.tsx" },
      ],
    }));
    const warnings = await lintExceptions(ex);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].warning).toMatch(/no issue link/i);
    expect(warnings[0].path).toBe("design-system/atoms/foo.tsx");
    expect(warnings[0].rule).toBe("DRIFT-MISPLACED");
  });

  it("warns when issue field is an empty string", async () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISCLASSIFIED-ATOM", path: "design-system/atoms/bar.tsx", issue: "" },
      ],
    }));
    const warnings = await lintExceptions(ex);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].warning).toMatch(/no issue link/i);
  });

  it("warns when referenced issue is closed", async () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/foo.tsx", issue: "#7" },
      ],
    }));
    const checker: IssueChecker = vi.fn().mockResolvedValue("closed");
    const warnings = await lintExceptions(ex, checker);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].warning).toMatch(/closed issue/i);
    expect(warnings[0].issue).toBe("#7");
  });

  it("does not warn when referenced issue is open", async () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/foo.tsx", issue: "https://github.com/owner/repo/issues/42" },
      ],
    }));
    const checker: IssueChecker = vi.fn().mockResolvedValue("open");
    const warnings = await lintExceptions(ex, checker);
    expect(warnings).toHaveLength(0);
  });

  it("does not warn on unknown issue status (checker returns unknown)", async () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/foo.tsx", issue: "#99" },
      ],
    }));
    const checker: IssueChecker = vi.fn().mockResolvedValue("unknown");
    const warnings = await lintExceptions(ex, checker);
    expect(warnings).toHaveLength(0);
  });

  it("accumulates warnings across multiple entries", async () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "a.tsx" },                      // missing issue → warning
        { rule: "DRIFT-MISCLASSIFIED-ATOM", path: "b.tsx", issue: "#5" }, // open → no warning
        { rule: "DRIFT-DS-IMPORTS-FEATURE", path: "c.tsx", issue: "#6" }, // closed → warning
      ],
    }));
    const checker: IssueChecker = vi.fn().mockImplementation(
      async (ref) => (ref === "#5" ? "open" : "closed")
    );
    const warnings = await lintExceptions(ex, checker);
    expect(warnings).toHaveLength(2);
  });

  it("includes rule and path in each warning object", async () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/x.tsx" },
      ],
    }));
    const warnings = await lintExceptions(ex);
    expect(warnings[0].rule).toBe("DRIFT-MISPLACED");
    expect(warnings[0].path).toBe("design-system/atoms/x.tsx");
    expect(warnings[0].issue).toBeUndefined();
  });

  it("does not warn on permanent exception without issue link", async () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/AppShell.tsx", permanent: true, reason: "intentional architectural decision" },
      ],
    }));
    const warnings = await lintExceptions(ex);
    expect(warnings).toHaveLength(0);
  });

  it("does not warn on permanent exception even when issue is closed", async () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/AppShell.tsx", permanent: true, issue: "#7", reason: "app chrome singleton" },
      ],
    }));
    const checker: IssueChecker = vi.fn().mockResolvedValue("closed");
    const warnings = await lintExceptions(ex, checker);
    expect(warnings).toHaveLength(0);
    expect(checker).not.toHaveBeenCalled();
  });

  it("still warns on non-permanent exception without issue link", async () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/foo.tsx" },
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/AppShell.tsx", permanent: true, reason: "app chrome" },
      ],
    }));
    const warnings = await lintExceptions(ex);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe("design-system/atoms/foo.tsx");
  });

  it("permanent:false is not treated as permanent — still warns on missing issue", async () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/foo.tsx", permanent: false, reason: "not actually permanent" },
      ],
    }));
    const warnings = await lintExceptions(ex);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].warning).toMatch(/no issue link/i);
  });

  it("permanent exception with both permanent:true and issue link is valid (no conflict)", async () => {
    const ex = parseExceptions(JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/atoms/AppShell.tsx", permanent: true, issue: "#42", reason: "app chrome" },
      ],
    }));
    const checker: IssueChecker = vi.fn().mockResolvedValue("open");
    const warnings = await lintExceptions(ex, checker);
    expect(warnings).toHaveLength(0);
  });
});
