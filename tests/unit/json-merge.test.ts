import { describe, it, expect } from "vitest";
import { mergeJsonKeys } from "../../src/lib/json-merge";

describe("mergeJsonKeys", () => {
  it("owned key from upstream replaces nothing when not in current", () => {
    const upstream = JSON.stringify({ hooks: { post: "x" } });
    const current = JSON.stringify({ permissions: ["read"] });
    const result = mergeJsonKeys(upstream, current, ["hooks"]);
    const parsed = JSON.parse(result);
    expect(parsed.hooks).toEqual({ post: "x" });
    expect(parsed.permissions).toEqual(["read"]);
  });

  it("user-only non-owned key preserved when absent in upstream", () => {
    const upstream = JSON.stringify({ hooks: { post: "x" } });
    const current = JSON.stringify({ permissions: ["write"], hooks: { post: "old" } });
    const result = mergeJsonKeys(upstream, current, ["hooks"]);
    const parsed = JSON.parse(result);
    expect(parsed.permissions).toEqual(["write"]);
  });

  it("conflicting owned key — upstream wins", () => {
    const upstream = JSON.stringify({ hooks: { post: "new" } });
    const current = JSON.stringify({ hooks: { post: "old" } });
    const result = mergeJsonKeys(upstream, current, ["hooks"]);
    const parsed = JSON.parse(result);
    expect(parsed.hooks).toEqual({ post: "new" });
  });

  it("conflicting non-owned key — current wins", () => {
    const upstream = JSON.stringify({ hooks: { post: "x" }, permissions: ["upstream-perm"] });
    const current = JSON.stringify({ permissions: ["current-perm"] });
    const result = mergeJsonKeys(upstream, current, ["hooks"]);
    const parsed = JSON.parse(result);
    expect(parsed.permissions).toEqual(["current-perm"]);
  });

  it("nested objects under owned key replaced wholesale, not deep-merged", () => {
    const upstream = JSON.stringify({ hooks: { a: 1, b: 2 } });
    const current = JSON.stringify({ hooks: { a: 99, c: 3 } });
    const result = mergeJsonKeys(upstream, current, ["hooks"]);
    const parsed = JSON.parse(result);
    // upstream value is used whole — c should be gone
    expect(parsed.hooks).toEqual({ a: 1, b: 2 });
    expect(parsed.hooks.c).toBeUndefined();
  });

  it("returns 2-space indented JSON with trailing newline", () => {
    const upstream = JSON.stringify({ hooks: {} });
    const current = JSON.stringify({ permissions: [] });
    const result = mergeJsonKeys(upstream, current, ["hooks"]);
    expect(result.endsWith("\n")).toBe(true);
    expect(result).toContain("  ");
  });

  it("throws a clear message on malformed upstream JSON", () => {
    expect(() => mergeJsonKeys("{bad json}", "{}", ["hooks"])).toThrow(/upstream/i);
  });

  it("throws a clear message on malformed current JSON", () => {
    expect(() => mergeJsonKeys("{}", "{bad json}", ["hooks"])).toThrow(/current/i);
  });
});
