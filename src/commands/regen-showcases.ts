import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { generateShowcase, toPascalCase } from "../lib/showcase/generator.js";

// The canonical, CLI-owned showcase regenerator (PRD #566, issue #568).
//
// The pack ships a thin shim (`scripts/generate-showcase-companion.ts`) that
// invokes this command — it is the ONE emission path for per-component
// `.showcase.tsx` companions. The directory walk below is the consumer-side
// loop that used to live in the pack script; the per-file emission delegates to
// `generateShowcase` (`src/lib/showcase/generator.ts`, issue #567), so there is
// no second parser to drift and no inlined analyzer region to sync.

const TIERS = ["atoms", "composites", "references"] as const;
const COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx"];
const SKIP_PATTERNS = [/^index\.ts$/, /\.logic\.ts$/, /\.d\.ts$/];

export async function regenShowcasesCmd(opts: { cwd?: string }): Promise<void> {
	const cwd = opts.cwd ?? process.cwd();

	let processed = 0;
	let skipped = 0;

	for (const tier of TIERS) {
		const tierDir = join(cwd, "design-system", tier);
		if (!existsSync(tierDir)) continue;

		let entries: string[];
		try {
			entries = readdirSync(tierDir);
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (entry === ".keep" || entry === ".gitkeep") continue;
			if (!entry.endsWith(".tsx")) continue;
			if (COMPANION_SUFFIXES.some((s) => entry.endsWith(s))) continue;
			if (SKIP_PATTERNS.some((re) => re.test(entry))) continue;

			const entryPath = join(tierDir, entry);
			const entryStat = statSync(entryPath, { throwIfNoEntry: false });
			if (!entryStat || !entryStat.isFile()) continue;

			const componentName = basename(entry, ".tsx");

			let source: string;
			try {
				source = readFileSync(entryPath, "utf8");
			} catch {
				process.stderr.write(`regen-showcases: cannot read ${entryPath}\n`);
				skipped++;
				continue;
			}

			const result = generateShowcase({ filePath: entryPath, source });

			if (result.content === null) {
				if (result.skipReason === "namespace-only") {
					// #69 / #92 / #295: a namespace-only export (`export const X = { A, B }`)
					// is not callable, so the generator cannot emit `<X … />` JSX. Skip and
					// leave the companion to a hand-authored file — a per-component limit,
					// not a fatal run error (the hook re-runs on every DS edit, so one such
					// component must not block every subsequent write).
					const displayName = toPascalCase(componentName);
					process.stderr.write(
						`${entryPath}:0: GEN-069: \`${displayName}\` is a namespace-only export (object literal, not callable). ` +
							`Generator cannot emit <${displayName} ... /> JSX. ` +
							`Either (a) hand-author \`${componentName}.showcase.tsx\` beside this file (it will be preserved across runs), ` +
							`or (b) export a top-level callable \`${displayName}\` component alongside the namespace object.\n`,
					);
				} else {
					process.stderr.write(
						`${entryPath}:0: GEN-000: no meta export found — skipping companion generation\n`,
					);
				}
				skipped++;
				continue;
			}

			const showcasePath = join(tierDir, `${componentName}.showcase.tsx`);
			mkdirSync(dirname(showcasePath), { recursive: true });
			writeFileSync(showcasePath, result.content, "utf8");
			console.log(`regen-showcases: wrote ${showcasePath}`);
			processed++;
		}
	}

	console.log(`regen-showcases: done — ${processed} component(s) processed, ${skipped} skipped`);
}
