/**
 * PRD #325 sub-issue #330 — the renderer module exposes one TTY-detection
 * helper. It is the only gate on the TTY-only runtime deps (`@clack/prompts`,
 * `picocolors`, `ora`); everywhere else asks this helper instead of poking
 * `process.stdout.isTTY` inline.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isTTY } from "../../../src/lib/render/index.js";

describe("isTTY", () => {
	const original = process.stdout.isTTY;
	afterEach(() => {
		process.stdout.isTTY = original;
	});

	it("returns true when process.stdout.isTTY is true", () => {
		process.stdout.isTTY = true;
		expect(isTTY()).toBe(true);
	});

	it("returns false when process.stdout.isTTY is false", () => {
		process.stdout.isTTY = false;
		expect(isTTY()).toBe(false);
	});

	it("returns false when process.stdout.isTTY is undefined", () => {
		// @ts-expect-error — intentionally clearing for the non-TTY branch
		process.stdout.isTTY = undefined;
		expect(isTTY()).toBe(false);
	});
});
