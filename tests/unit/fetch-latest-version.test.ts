import { describe, expect, it } from "vitest";
import { fetchLatestVersion } from "../../src/commands/version.js";

describe("fetchLatestVersion", () => {
	it("returns v-prefixed version when the registry responds", async () => {
		const result = await fetchLatestVersion(async () => ({
			status: 200,
			body: JSON.stringify({ name: "claude-ds", version: "1.8.0" }),
		}));
		expect(result).toEqual({ ok: true, tag: "v1.8.0" });
	});

	it("returns ok:true tag:null on 404 (package not published yet)", async () => {
		const result = await fetchLatestVersion(async () => ({
			status: 404,
			body: JSON.stringify({ error: "Not found" }),
		}));
		expect(result).toEqual({ ok: true, tag: null });
	});

	it("returns ok:false with reason on non-200/404 status", async () => {
		const result = await fetchLatestVersion(async () => ({ status: 503, body: "" }));
		expect(result.ok).toBe(false);
		if (result.ok === false) expect(result.reason).toMatch(/503/);
	});

	it("returns ok:false when the fetch itself rejects (offline, DNS)", async () => {
		const result = await fetchLatestVersion(async () => {
			throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
		});
		expect(result.ok).toBe(false);
		if (result.ok === false) expect(result.reason).toMatch(/ENOTFOUND/);
	});

	it("returns ok:false on unparseable or shapeless JSON", async () => {
		const garbage = await fetchLatestVersion(async () => ({ status: 200, body: "<html>" }));
		expect(garbage.ok).toBe(false);

		const shapeless = await fetchLatestVersion(async () => ({
			status: 200,
			body: JSON.stringify({ version: 42 }),
		}));
		expect(shapeless.ok).toBe(false);
	});
});
