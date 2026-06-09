import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import picomatch from "picomatch";
import type { Tier } from "../classifier.js";

export const COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx"];
const SKIP_PATTERNS = [/^index\.ts$/, /\.logic\.ts$/, /\.d\.ts$/];
// React components live in `.tsx` by convention. Narrowing the brownfield
// walk to `.tsx` keeps zero-signal `.ts` server modules (route handlers, db
// schema, lib utilities, test files) out of design-system/atoms/. This is the
// remaining gap behind #209's "everything became an atom" reproduction —
// classifier still defaults a no-signal source to `atom`, but the walker no
// longer hands it non-React files to default on.
const SOURCE_EXTS = [".tsx"];

export interface ClassifiedFile {
	srcRel: string; // relative to cwd, e.g. "src/components/button.tsx"
	tier: Tier;
	domainBucket: string | null; // set for feature-tier: "features/invoicing"
}

export interface MovePlan {
	srcRel: string;
	destRel: string;
	label: string;
}

/** Extract the first domain bucket (e.g. "features/invoicing") a file imports from. */
export function inferDomainBucket(source: string, domainRoots: string[]): string | null {
	for (const root of domainRoots) {
		const re = new RegExp(`from\\s+["'][^"']*[/\\\\]${root}[/\\\\]([^/"']+)`);
		const m = re.exec(source);
		if (m) return `${root}/${m[1]}`;
	}
	return null;
}

/**
 * Build the predicate that keeps classify's walk inside design-system scope
 * (ADR-0005, issue #209). A cwd-relative path is excluded when it is:
 *   - under design-system/ (already organized),
 *   - under app_dir (routed pages/layouts — never a DS part),
 *   - under a domain root (features/, lib/ — app code by definition), or
 *   - matched by a lookalike_ignore glob the consumer declared out-of-scope.
 * Excluding these dirs means classify can never relocate app code into
 * design-system/ even when --src points at a broad tree.
 */
export function makeExcluder(opts: {
	appDir: string;
	domainRoots: string[];
	ignoreGlobs: string[];
}): (rel: string) => boolean {
	const matchIgnore =
		opts.ignoreGlobs.length > 0 ? picomatch(opts.ignoreGlobs, { dot: true }) : () => false;
	const appDir = opts.appDir.replace(/\/$/, "");
	return (rel: string): boolean => {
		const segs = rel.split("/");
		if (segs.includes("design-system")) return true;
		if (segs.some((s) => opts.domainRoots.includes(s))) return true;
		if (rel === appDir || rel.startsWith(`${appDir}/`)) return true;
		if (matchIgnore(rel)) return true;
		return false;
	};
}

/** Walk a directory and return .tsx/.ts files (relative to cwd), skipping companions and excluded paths. */
export async function walkComponentDir(
	cwd: string,
	srcRel: string,
	exclude: (rel: string) => boolean,
): Promise<string[]> {
	const abs = join(cwd, srcRel);
	let entries: Dirent[];
	try {
		entries = await readdir(abs, { withFileTypes: true });
	} catch {
		return [];
	}
	const results: string[] = [];
	for (const e of entries) {
		const childRel = `${srcRel}/${e.name}`;
		if (exclude(childRel)) continue;
		if (e.isDirectory()) {
			results.push(...(await walkComponentDir(cwd, childRel, exclude)));
			continue;
		}
		if (!e.isFile()) continue;
		if (!SOURCE_EXTS.some((ext) => e.name.endsWith(ext))) continue;
		if (COMPANION_SUFFIXES.some((s) => e.name.endsWith(s))) continue;
		if (SKIP_PATTERNS.some((re) => re.test(e.name))) continue;
		results.push(childRel);
	}
	return results;
}

export function tierToDir(tier: "atom" | "composite"): string {
	return tier === "atom" ? "design-system/atoms" : "design-system/composites";
}

/**
 * TTY prompt for the single classify commitment-gate. Maps a [y/N] answer onto
 * the [Apply, Skip] options the spine resolver expects (index 0 = Apply, 1 =
 * Skip). `[s]`/blank/no = Skip; anything starting with `y` = Apply. The full
 * preview is printed by the caller before the gate; this helper only owns the
 * yes/no read.
 */
export async function confirmGate(question: string, _options: unknown): Promise<number> {
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const ans = await rl.question(`${question} [y/N] `);
		const v = ans.trim().toLowerCase();
		return v === "y" || v === "yes" ? 0 : 1;
	} finally {
		rl.close();
	}
}
