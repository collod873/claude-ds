/**
 * PRD #325 sub-issue #326 — `--answers <file>` loads a JSON bag keyed by
 * Decision id into `ctx.decisions`. Values are `number` (chosen option
 * index) or `"defer"`. Any other shape is rejected at load time so a
 * malformed answers file fails before the resolver runs.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAnswersFile } from "../../src/lib/decision/index.js";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

describe("loadAnswersFile", () => {
	it("parses a JSON object keyed by Decision id with number / 'defer' values", async () => {
		const dir = await freshTmpDir();
		try {
			const path = join(dir, "answers.json");
			await writeFile(
				path,
				JSON.stringify({
					"raw-color:design-system/atoms/button.tsx": 0,
					"first-run-fork": "defer",
					"extract:Sidebar": 2,
				}),
			);
			const bag = await loadAnswersFile(path);
			expect(bag).toEqual({
				"raw-color:design-system/atoms/button.tsx": 0,
				"first-run-fork": "defer",
				"extract:Sidebar": 2,
			});
		} finally {
			await cleanup(dir);
		}
	});

	it("rejects an answers file whose root is not an object", async () => {
		const dir = await freshTmpDir();
		try {
			const path = join(dir, "answers.json");
			await writeFile(path, JSON.stringify(["not", "an", "object"]));
			await expect(loadAnswersFile(path)).rejects.toThrow(/object/);
		} finally {
			await cleanup(dir);
		}
	});

	it("rejects values that are neither number nor 'defer'", async () => {
		const dir = await freshTmpDir();
		try {
			const path = join(dir, "answers.json");
			await writeFile(path, JSON.stringify({ x: true }));
			await expect(loadAnswersFile(path)).rejects.toThrow(/x/);
		} finally {
			await cleanup(dir);
		}
	});
});
