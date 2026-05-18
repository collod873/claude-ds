import { describe, it, expect } from "vitest";
import { extractChangelogSections } from "../../src/commands/version.js";

const SAMPLE_CHANGELOG = `
# Changelog

## [Unreleased]

## [0.5.6] — untagged

### Pack changes
- foo bar

## [0.5.5] — untagged

### Pack changes
- baz qux

## [0.5.4] — git tag

### Pack changes
- quux

## [0.5.0] — git tag

### Pack changes
- initial
`;

describe("extractChangelogSections", () => {
  it("returns sections strictly between pinned and installed (exclusive lower, inclusive upper)", () => {
    const sections = extractChangelogSections(SAMPLE_CHANGELOG, "v0.5.0", "v0.5.6");
    // Should include 0.5.4, 0.5.5, 0.5.6 — NOT 0.5.0
    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatch(/\[0\.5\.6\]/);
    expect(sections[1]).toMatch(/\[0\.5\.5\]/);
    expect(sections[2]).toMatch(/\[0\.5\.4\]/);
  });

  it("returns empty when pinned equals installed", () => {
    const sections = extractChangelogSections(SAMPLE_CHANGELOG, "v0.5.6", "v0.5.6");
    expect(sections).toHaveLength(0);
  });

  it("returns single section when one version apart", () => {
    const sections = extractChangelogSections(SAMPLE_CHANGELOG, "v0.5.5", "v0.5.6");
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatch(/\[0\.5\.6\]/);
  });

  it("returns empty when pinned is newer than installed (no-op)", () => {
    const sections = extractChangelogSections(SAMPLE_CHANGELOG, "v0.5.6", "v0.5.0");
    expect(sections).toHaveLength(0);
  });
});
