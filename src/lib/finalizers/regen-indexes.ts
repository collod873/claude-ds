import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Change } from "../operation.js";
import type { ProjectContext } from "../project.js";
import { metaKindFromSource } from "../three-signal.js";

const COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx", ".snapshot.tsx"];
const TIER_DIRS = ["atoms", "composites", "patterns"] as const;
const TIER_KIND: Record<string, string> = {
	atoms: "atom",
	composites: "composite",
	patterns: "pattern",
};

function isCompanion(fileName: string): boolean {
	return COMPANION_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

const EXPORT_DECL_RE = /\bexport\s+(?:async\s+)?(?:function\*?|const|let|var|class|enum)\s+(\w+)/g;

function extractExportedNames(source: string): string[] {
	const names: string[] = [];
	const re = new RegExp(EXPORT_DECL_RE.source, "g");
	for (const m of source.matchAll(re)) {
		if (m[1] !== "meta") names.push(m[1]);
	}
	return [...new Set(names)];
}

interface ComponentEntry {
	name: string;
	tier: string;
	kind: string;
	path: string;
	path_no_ext: string;
	has_showcase: boolean;
	has_test: boolean;
}

export async function regenIndexes(ctx: ProjectContext): Promise<Change[]> {
	const cwd = ctx.cwd;
	const dsRoot = join(cwd, "design-system");
	const changes: Change[] = [];
	const allComponents: ComponentEntry[] = [];

	for (const tierDir of TIER_DIRS) {
		const dirPath = join(dsRoot, tierDir);
		let entries: string[];
		try {
			entries = await readdir(dirPath);
		} catch {
			continue;
		}

		const componentFiles = entries.filter((f) => f.endsWith(".tsx") && !isCompanion(f)).sort();

		const barrelLines: string[] = [];
		for (const f of componentFiles) {
			const name = f.slice(0, -extname(f).length);
			const filePath = join(dsRoot, tierDir, f);
			let source: string;
			try {
				source = await readFile(filePath, "utf8");
			} catch {
				continue;
			}
			const exportedNames = extractExportedNames(source);
			if (exportedNames.length > 0) {
				barrelLines.push(`export { ${exportedNames.join(", ")} } from "./${name}";`);
			}
		}
		const barrelContent = barrelLines.length > 0 ? `${barrelLines.join("\n")}\n` : "";

		const barrelPath = `design-system/${tierDir}/index.ts`;
		const absBarrelPath = join(cwd, barrelPath);
		let existing: string | null = null;
		try {
			existing = await readFile(absBarrelPath, "utf8");
		} catch {
			/* doesn't exist yet */
		}

		if (barrelContent !== (existing ?? "")) {
			changes.push({
				kind: "write",
				path: barrelPath,
				before: existing !== null ? Buffer.from(existing) : null,
				after: Buffer.from(barrelContent),
			});
		}

		for (const f of componentFiles) {
			const name = f.slice(0, -extname(f).length);
			const filePath = `design-system/${tierDir}/${f}`;
			let source: string;
			try {
				source = await readFile(join(cwd, filePath), "utf8");
			} catch {
				continue;
			}
			const metaKind = metaKindFromSource(source);
			const fallbackKind = TIER_KIND[tierDir];

			allComponents.push({
				name,
				tier: fallbackKind,
				kind: metaKind ?? fallbackKind,
				path: filePath,
				path_no_ext: `design-system/${tierDir}/${name}`,
				has_showcase: entries.includes(`${name}.showcase.tsx`),
				has_test: entries.includes(`${name}.test.tsx`),
			});
		}
	}

	if (allComponents.length === 0) return changes;

	const manifest = {
		generated: new Date().toISOString(),
		components: allComponents,
	};
	const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
	const manifestPath = "design-system/manifest.json";
	let existingManifest: string | null = null;
	try {
		existingManifest = await readFile(join(cwd, manifestPath), "utf8");
	} catch {
		/* doesn't exist */
	}

	changes.push({
		kind: "write",
		path: manifestPath,
		before: existingManifest !== null ? Buffer.from(existingManifest) : null,
		after: Buffer.from(manifestContent),
	});

	return changes;
}
