/**
 * PRD #325 sub-issue #330 — the new runtime deps (`@clack/prompts`,
 * `picocolors`, `ora`) are TTY-only. Non-TTY commands must not load them on
 * the hot path; static imports therefore live exclusively inside the
 * `tty-layer.ts` module, which itself is only imported behind the central
 * `isTTY()` helper.
 *
 * This is a structural test: it walks every `.ts` file under `src/lib/render/`
 * and asserts no static `import` statement references the TTY-only deps
 * outside `tty-layer.ts`. Code that reaches them must do so via dynamic
 * `await import(...)` from inside an `isTTY()`-gated function.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TTY_ONLY_DEPS = ["@clack/prompts", "picocolors", "ora"];
const TTY_LAYER_BASENAME = "tty-layer.ts";

const STATIC_IMPORT_RE = /^\s*import\s+(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/gm;

async function walkTs(dir: string): Promise<string[]> {
	const out: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) out.push(...(await walkTs(full)));
		else if (e.isFile() && e.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

describe("TTY-only runtime deps live behind the single isTTY() gate", () => {
	it("no .ts file under src/lib/render/ except tty-layer.ts statically imports a TTY-only dep", async () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const renderDir = join(here, "..", "..", "..", "src", "lib", "render");
		const files = await walkTs(renderDir);
		expect(files.length).toBeGreaterThan(0);

		const offenders: { file: string; spec: string }[] = [];
		for (const file of files) {
			const basename = file.split("/").pop()!;
			const allowed = basename === TTY_LAYER_BASENAME;
			const src = await readFile(file, "utf8");
			const matches = src.matchAll(STATIC_IMPORT_RE);
			for (const m of matches) {
				const spec = m[1];
				if (TTY_ONLY_DEPS.some((d) => spec === d || spec.startsWith(`${d}/`))) {
					if (!allowed) offenders.push({ file, spec });
				}
			}
		}

		expect(offenders).toEqual([]);
	});
});
