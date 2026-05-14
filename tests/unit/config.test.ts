import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "../../src/lib/config";

describe("parseConfig", () => {
  it("accepts a valid v1 config and applies defaults", () => {
    const c = parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"warn"}`);
    expect(c.enforce_threshold).toBe(10);
    expect(c.removed).toEqual([]);
  });
  it("rejects unknown keys", () => {
    expect(() => parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"warn","extra":1}`))
      .toThrow(ConfigError);
  });
  it("rejects a malformed version", () => {
    expect(() => parseConfig(`{"version":"1.0","pack":"next-react","mode":"warn"}`))
      .toThrow(ConfigError);
  });
  it("rejects an invalid mode", () => {
    expect(() => parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"hard"}`))
      .toThrow(ConfigError);
  });
});
