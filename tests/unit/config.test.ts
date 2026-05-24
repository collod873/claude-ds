import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError } from "../../src/lib/config";

describe("parseConfig", () => {
  it("accepts a valid v1 config and applies defaults", () => {
    const c = parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"warn"}`);
    expect(c.enforce_threshold).toBe(10);
    expect(c.removed).toEqual([]);
  });
  it("accepts packVersion as the primary version key", () => {
    const c = parseConfig(`{"packVersion":"v1.0.0","pack":"next-react","mode":"warn"}`);
    expect(c.packVersion).toBe("v1.0.0");
  });
  it("maps legacy version key to packVersion field", () => {
    const c = parseConfig(`{"version":"v0.7.0","pack":"next-react","mode":"warn"}`);
    expect(c.packVersion).toBe("v0.7.0");
  });
  it("accepts pre-release version suffixes (RC tags)", () => {
    const c = parseConfig(`{"packVersion":"v0.8.0-rc.1","pack":"next-react","mode":"warn"}`);
    expect(c.packVersion).toBe("v0.8.0-rc.1");
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
  it("rejects invalid JSON", () => {
    expect(() => parseConfig(`{not json`)).toThrow(ConfigError);
  });
  it("rejects negative enforce_threshold", () => {
    expect(() => parseConfig(`{"version":"v1.0.0","pack":"x","mode":"warn","enforce_threshold":-1}`))
      .toThrow(ConfigError);
  });
  it("rejects non-integer enforce_threshold", () => {
    expect(() => parseConfig(`{"version":"v1.0.0","pack":"x","mode":"warn","enforce_threshold":1.5}`))
      .toThrow(ConfigError);
  });
  it("rejects removed with non-string elements", () => {
    expect(() => parseConfig(`{"version":"v1.0.0","pack":"x","mode":"warn","removed":["a",1]}`))
      .toThrow(ConfigError);
  });

  // v0.2.1: lookalike_ignore field
  it("accepts valid lookalike_ignore string array", () => {
    const c = parseConfig(`{"version":"v1.0.0","pack":"x","mode":"warn","lookalike_ignore":[".vercel/**","**/_actions/**"]}`);
    expect(c.lookalike_ignore).toEqual([".vercel/**", "**/_actions/**"]);
  });

  it("defaults lookalike_ignore to [] when absent (v0.2.0 files continue to work)", () => {
    const c = parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"warn"}`);
    expect(c.lookalike_ignore).toEqual([]);
  });

  it("rejects lookalike_ignore with non-string elements", () => {
    expect(() => parseConfig(`{"version":"v1.0.0","pack":"x","mode":"warn","lookalike_ignore":[".vercel/**",42]}`))
      .toThrow(ConfigError);
  });

  it("rejects lookalike_ignore that is not an array", () => {
    expect(() => parseConfig(`{"version":"v1.0.0","pack":"x","mode":"warn","lookalike_ignore":".vercel/**"}`))
      .toThrow(ConfigError);
  });
});
