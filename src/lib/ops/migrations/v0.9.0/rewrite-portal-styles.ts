import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../../../operation.js";
import type { ProjectContext } from "../../../project.js";

const DS_TIERS = ["atoms", "composites"] as const;
const PORTAL_SCOPE_IMPORT = `import portalStyles from "@ds/utils/portal-scope.module.css";`;

// Matches: className={expr} style={{ display: "contents" }}
const CN_THEN_STYLE_RE = /className=\{([^}]+)\}\s*style=\{\{\s*display:\s*"contents"\s*\}\}/g;
// Matches: style={{ display: "contents" }} className={expr}
const STYLE_THEN_CN_RE = /style=\{\{\s*display:\s*"contents"\s*\}\}\s*className=\{([^}]+)\}/g;
// Matches standalone: style={{ display: "contents" }} (no adjacent className)
const STANDALONE_STYLE_RE = /style=\{\{\s*display:\s*"contents"\s*\}\}/g;

/**
 * Migration Op for v0.9.0: rewrite inline style={{ display: "contents" }}
 * to use the portal-scope CSS module class.
 *
 * Handles three cases:
 * 1. className={x} style={{ display: "contents" }} → className={cn(x, portalStyles.portalScope)}
 * 2. style={{ display: "contents" }} className={x} → className={cn(x, portalStyles.portalScope)}
 * 3. style={{ display: "contents" }} alone → className={portalStyles.portalScope}
 */
export const rewritePortalStyles: Operation = {
	name: "rewrite-portal-styles@v0.9.0",
	async plan(ctx: ProjectContext): Promise<Change[]> {
		const changes: Change[] = [];

		for (const tier of DS_TIERS) {
			const absDir = join(ctx.cwd, "design-system", tier);
			let entries: string[];
			try {
				entries = await readdir(absDir);
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.endsWith(".tsx")) continue;
				const rel = `design-system/${tier}/${entry}`;
				const abs = join(ctx.cwd, rel);
				let source: string;
				try {
					source = await readFile(abs, "utf8");
				} catch {
					continue;
				}
				if (
					!source.includes('style={{ display: "contents" }}') &&
					!source.includes("style={{ display: 'contents' }}") &&
					!source.includes('style={{display: "contents"}}')
				)
					continue;

				let updated = source;

				// Case 1: className before style
				updated = updated.replace(CN_THEN_STYLE_RE, (_match, cnExpr) => {
					return `className={cn(${cnExpr}, portalStyles.portalScope)}`;
				});

				// Case 2: style before className
				updated = updated.replace(STYLE_THEN_CN_RE, (_match, cnExpr) => {
					return `className={cn(${cnExpr}, portalStyles.portalScope)}`;
				});

				// Case 3: standalone style (no adjacent className)
				updated = updated.replace(STANDALONE_STYLE_RE, `className={portalStyles.portalScope}`);

				if (updated === source) continue;

				if (!updated.includes("portalStyles from")) {
					const importInsertIdx = findLastImportEnd(updated);
					updated =
						updated.slice(0, importInsertIdx) +
						PORTAL_SCOPE_IMPORT +
						"\n" +
						updated.slice(importInsertIdx);
				}

				changes.push({
					kind: "write",
					path: rel,
					before: Buffer.from(source, "utf8"),
					after: Buffer.from(updated, "utf8"),
				});
			}
		}

		return changes;
	},
};

function findLastImportEnd(source: string): number {
	const lines = source.split("\n");
	let lastImportLine = 0;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*import\s/.test(lines[i])) {
			lastImportLine = i;
		}
	}
	let idx = 0;
	for (let i = 0; i <= lastImportLine; i++) {
		idx += lines[i].length + 1;
	}
	return idx;
}
