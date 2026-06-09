/**
 * PRD #336 — pure version-currency helper. Compares a consumer's pinned
 * `packVersion` against the installed CLI version. Used by both `version
 * --check` and the dashboard brain (`upgrade-available` signal), so the
 * comparison lives in one place.
 *
 * Inputs are `vX.Y.Z` semver strings; the helper handles a leading `v` and
 * tolerates either side carrying or omitting it. Stale = pinned < installed.
 */
import { describe, expect, it } from "vitest";
import { checkVersionCurrency } from "../../src/lib/version-currency.js";

describe("checkVersionCurrency", () => {
	it("flags pinned older than installed as stale (upgrade available)", () => {
		const r = checkVersionCurrency({ pinned: "v0.8.0", installed: "v1.1.0" });
		expect(r.upgradeAvailable).toBe(true);
		expect(r.pinned).toBe("v0.8.0");
		expect(r.installed).toBe("v1.1.0");
	});

	it("treats equal versions as up to date", () => {
		const r = checkVersionCurrency({ pinned: "v1.1.0", installed: "v1.1.0" });
		expect(r.upgradeAvailable).toBe(false);
	});

	it("treats pinned newer than installed as up to date (no downgrade nudge)", () => {
		const r = checkVersionCurrency({ pinned: "v2.0.0", installed: "v1.1.0" });
		expect(r.upgradeAvailable).toBe(false);
	});

	it("normalizes the leading v on either side", () => {
		expect(checkVersionCurrency({ pinned: "0.8.0", installed: "v1.1.0" }).upgradeAvailable).toBe(
			true,
		);
		expect(checkVersionCurrency({ pinned: "v0.8.0", installed: "1.1.0" }).upgradeAvailable).toBe(
			true,
		);
	});

	it("compares by minor and patch, not just major", () => {
		expect(checkVersionCurrency({ pinned: "v1.0.0", installed: "v1.1.0" }).upgradeAvailable).toBe(
			true,
		);
		expect(checkVersionCurrency({ pinned: "v1.1.0", installed: "v1.1.1" }).upgradeAvailable).toBe(
			true,
		);
		expect(checkVersionCurrency({ pinned: "v1.1.1", installed: "v1.1.0" }).upgradeAvailable).toBe(
			false,
		);
	});
});
