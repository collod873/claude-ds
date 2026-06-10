/**
 * Unit tests for formatter detection (issue #493).
 *
 * The post-sync formatter pass only fires for a formatter `detectFormatter` can
 * see. Config-file detection (biome.json / .prettierrc) misses consumers that
 * configure biome via `extends`, a non-standard config path, or a lint script —
 * so detection also falls back to the declared dependency in package.json.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectFormatter } from "../../src/lib/formatter";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

describe("detectFormatter — package.json fallback (#493)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir("fmt-detect-");
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("detects biome from devDependencies when no config file is present", async () => {
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ devDependencies: { "@biomejs/biome": "2.4.8" } }),
		);
		expect(await detectFormatter(dir)).toBe("biome");
	});

	it("detects prettier from devDependencies when no config file is present", async () => {
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ devDependencies: { prettier: "3.0.0" } }),
		);
		expect(await detectFormatter(dir)).toBe("prettier");
	});

	it("biome wins over prettier when both are declared", async () => {
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ devDependencies: { prettier: "3.0.0", "@biomejs/biome": "2.4.8" } }),
		);
		expect(await detectFormatter(dir)).toBe("biome");
	});

	it("a config file still takes precedence over package.json", async () => {
		await writeFile(join(dir, "biome.json"), "{}");
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ devDependencies: { prettier: "3.0.0" } }),
		);
		expect(await detectFormatter(dir)).toBe("biome");
	});

	it("returns null when neither a config nor a declared dependency exists", async () => {
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ devDependencies: { react: "18" } }),
		);
		expect(await detectFormatter(dir)).toBeNull();
	});

	it("returns null when package.json is absent", async () => {
		expect(await detectFormatter(dir)).toBeNull();
	});
});
