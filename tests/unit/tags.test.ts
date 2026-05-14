import { describe, it, expect } from "vitest";
import { parseLsRemote, cmpSemver, isMajorBump, TagError } from "../../src/lib/tags";

describe("tags", () => {
  it("parses ls-remote output to v-tags", () => {
    const stdout = [
      "abc123\trefs/tags/v1.0.0",
      "def456\trefs/tags/v1.2.0",
      "ghi789\trefs/tags/v2.0.0",
      "jkl012\trefs/tags/not-a-version",
    ].join("\n");
    expect(parseLsRemote(stdout)).toEqual(["v1.0.0","v1.2.0","v2.0.0"]);
  });
  it("compares semvers", () => {
    expect(cmpSemver("v1.2.0","v1.10.0")).toBeLessThan(0);
  });
  it("detects major bump", () => {
    expect(isMajorBump("v1.5.0","v2.0.0")).toBe(true);
    expect(isMajorBump("v1.5.0","v1.6.0")).toBe(false);
    expect(isMajorBump("v1.5.0","v1.5.0")).toBe(false);
  });
  it("returns 0 for equal semvers", () => {
    expect(cmpSemver("v1.2.3","v1.2.3")).toBe(0);
  });
  it("returns [] for empty ls-remote output", () => {
    expect(parseLsRemote("")).toEqual([]);
  });
  it("throws TagError on malformed input", () => {
    expect(() => cmpSemver("v1.0.0","not-a-tag")).toThrow(TagError);
    expect(() => isMajorBump("1.0.0","v2.0.0")).toThrow(TagError);
  });
});
