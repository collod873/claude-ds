import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../src/lib/config";

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
		expect(() =>
			parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"warn","extra":1}`),
		).toThrow(ConfigError);
	});
	it("rejects a malformed version", () => {
		expect(() => parseConfig(`{"version":"1.0","pack":"next-react","mode":"warn"}`)).toThrow(
			ConfigError,
		);
	});
	it("rejects an invalid mode", () => {
		expect(() => parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"hard"}`)).toThrow(
			ConfigError,
		);
	});
	it("rejects invalid JSON", () => {
		expect(() => parseConfig(`{not json`)).toThrow(ConfigError);
	});
	it("rejects negative enforce_threshold", () => {
		expect(() =>
			parseConfig(`{"version":"v1.0.0","pack":"x","mode":"warn","enforce_threshold":-1}`),
		).toThrow(ConfigError);
	});
	it("rejects non-integer enforce_threshold", () => {
		expect(() =>
			parseConfig(`{"version":"v1.0.0","pack":"x","mode":"warn","enforce_threshold":1.5}`),
		).toThrow(ConfigError);
	});
	it("rejects removed with non-string elements", () => {
		expect(() =>
			parseConfig(`{"version":"v1.0.0","pack":"x","mode":"warn","removed":["a",1]}`),
		).toThrow(ConfigError);
	});

	// v0.2.1: lookalike_ignore field
	it("accepts valid lookalike_ignore string array", () => {
		const c = parseConfig(
			`{"version":"v1.0.0","pack":"x","mode":"warn","lookalike_ignore":[".vercel/**","**/_actions/**"]}`,
		);
		expect(c.lookalike_ignore).toEqual([".vercel/**", "**/_actions/**"]);
	});

	it("defaults lookalike_ignore to [] when absent (v0.2.0 files continue to work)", () => {
		const c = parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"warn"}`);
		expect(c.lookalike_ignore).toEqual([]);
	});

	it("rejects lookalike_ignore with non-string elements", () => {
		expect(() =>
			parseConfig(
				`{"version":"v1.0.0","pack":"x","mode":"warn","lookalike_ignore":[".vercel/**",42]}`,
			),
		).toThrow(ConfigError);
	});

	it("rejects lookalike_ignore that is not an array", () => {
		expect(() =>
			parseConfig(`{"version":"v1.0.0","pack":"x","mode":"warn","lookalike_ignore":".vercel/**"}`),
		).toThrow(ConfigError);
	});

	// srcRoot field (v0.9.0)
	it("defaults srcRoot to 'src' when absent", () => {
		const c = parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"warn"}`);
		expect(c.srcRoot).toBe("src");
	});

	it("accepts srcRoot '.'", () => {
		const c = parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"warn","srcRoot":"."}`);
		expect(c.srcRoot).toBe(".");
	});

	it("accepts srcRoot 'src'", () => {
		const c = parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"warn","srcRoot":"src"}`);
		expect(c.srcRoot).toBe("src");
	});

	it("rejects empty string srcRoot", () => {
		expect(() => parseConfig(`{"version":"v1.0.0","pack":"x","mode":"warn","srcRoot":""}`)).toThrow(
			ConfigError,
		);
	});

	// ds_aliases field
	it("defaults ds_aliases to [] when absent", () => {
		const c = parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"warn"}`);
		expect(c.ds_aliases).toEqual([]);
	});

	it("accepts valid ds_aliases string array", () => {
		const c = parseConfig(
			`{"version":"v1.0.0","pack":"next-react","mode":"warn","ds_aliases":["@ds"]}`,
		);
		expect(c.ds_aliases).toEqual(["@ds"]);
	});

	it("rejects ds_aliases with non-string elements", () => {
		expect(() =>
			parseConfig(`{"version":"v1.0.0","pack":"x","mode":"warn","ds_aliases":["@ds",42]}`),
		).toThrow(ConfigError);
	});

	it("rejects ds_aliases that is not an array", () => {
		expect(() =>
			parseConfig(`{"version":"v1.0.0","pack":"x","mode":"warn","ds_aliases":"@ds"}`),
		).toThrow(ConfigError);
	});

	it("rejects ds_aliases with empty string elements", () => {
		expect(() =>
			parseConfig(`{"version":"v1.0.0","pack":"x","mode":"warn","ds_aliases":[""]}`),
		).toThrow(ConfigError);
	});

	// role_contracts_strict (PRD #301 / #311) — mirrors meta_kind_strict
	it("defaults role_contracts_strict to false when absent", () => {
		const c = parseConfig(`{"version":"v1.0.0","pack":"next-react","mode":"warn"}`);
		expect(c.role_contracts_strict).toBe(false);
	});

	it("accepts role_contracts_strict: true", () => {
		const c = parseConfig(
			`{"version":"v1.0.0","pack":"next-react","mode":"warn","role_contracts_strict":true}`,
		);
		expect(c.role_contracts_strict).toBe(true);
	});

	it("accepts role_contracts_strict: false explicitly", () => {
		const c = parseConfig(
			`{"version":"v1.0.0","pack":"next-react","mode":"warn","role_contracts_strict":false}`,
		);
		expect(c.role_contracts_strict).toBe(false);
	});
});
