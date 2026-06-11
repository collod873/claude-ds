import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import * as ts from "typescript";

import { analyzeCvaComponents, cvaUnresolvedPropsDiagnostics } from "../cva/analyzer.js";
import { primaryComponent, primaryComponentNames } from "../drift/cva.js";
import type { ProjectContext } from "../project.js";
import { walkDir } from "./unexpected-files.js";

/**
 * A coverage-loss diagnostic surfaced by doctor/audit (#570). Makes silent
 * coverage shrink visible without changing detection or fix behavior — the
 * conservative silent-skip stance stays; the warning is the new part.
 *
 *   - `unresolvable-props`: a cva-consuming component whose props type the
 *     analyzer cannot resolve, so consumed axes were dropped for lack of local
 *     evidence (the component may have vanished from attribution and the
 *     showcase variant grid without a trace).
 *   - `render-target-unresolved`: no export matches the file's render-target
 *     name (acronym export like `QRCode`, index.tsx-per-folder atom,
 *     basename↔export mismatch), which silently disables
 *     `DRIFT-CVA-VARIANT-UNRENDERED`, `DRIFT-META-EXAMPLES-INVALID-PROP`, and
 *     raw-primitive variant inference for the file.
 */
export type CvaCoverageWarning =
	| {
			kind: "unresolvable-props";
			file: string;
			component: string;
			unresolvedType: string;
			axes: string[];
	  }
	| {
			kind: "render-target-unresolved";
			file: string;
			expected: string[];
			components: string[];
	  };

/**
 * Coverage-loss warnings for one source file. Pure over `(source, file)` so it
 * can be tested directly and shared by both `audit` and `doctor`.
 */
export function cvaCoverageWarnings(source: string, file: string): CvaCoverageWarning[] {
	if (!source.includes("cva(")) return [];
	const warnings: CvaCoverageWarning[] = [];

	// Render-target resolution failure: the file has cva-consuming exported
	// components, but none matches the showcase generator's render-target name
	// (PascalCase basename / raw basename). When that happens, the three drift
	// rules scoped to the primary component go dark for the file.
	const attribution = analyzeCvaComponents(ts, source, basename(file));
	const components = Object.keys(attribution);
	if (components.length > 0 && !primaryComponent(attribution, file)) {
		warnings.push({
			kind: "render-target-unresolved",
			file,
			expected: primaryComponentNames(file),
			components,
		});
	}

	// Unresolvable props type: a cva-consuming component whose props type is an
	// external type the analyzer can't read, so axes were dropped for lack of
	// evidence rather than proven not to be props.
	for (const d of cvaUnresolvedPropsDiagnostics(ts, source, basename(file))) {
		warnings.push({
			kind: "unresolvable-props",
			file,
			component: d.component,
			unresolvedType: d.unresolvedType,
			axes: d.droppedAxes,
		});
	}

	return warnings;
}

const COVERAGE_TIER_DIRS = [
	"design-system/atoms",
	"design-system/composites",
	"design-system/patterns",
];

/** Project-relative tier `.tsx` files (excluding companions), top level only. */
function isCoverageScanTarget(f: string): boolean {
	if (!f.endsWith(".tsx")) return false;
	if (f.endsWith(".showcase.tsx") || f.endsWith(".test.tsx") || f.endsWith(".stories.tsx")) {
		return false;
	}
	const subPath = f.slice("design-system/".length);
	return COVERAGE_TIER_DIRS.some(
		(d) => f.startsWith(`${d}/`) && !subPath.slice(subPath.indexOf("/") + 1).includes("/"),
	);
}

/**
 * Walk the DS tier dirs and collect coverage-loss warnings across the project.
 * Pure read — no writes, no printing. Shared by `audit` and `doctor` so a
 * coverage warning surfaces identically from either entry point.
 */
export async function scanCvaCoverage(ctx: ProjectContext): Promise<CvaCoverageWarning[]> {
	const { cwd } = ctx;
	const warnings: CvaCoverageWarning[] = [];
	let dsFiles: string[];
	try {
		dsFiles = await walkDir(cwd, "design-system");
	} catch {
		return warnings;
	}
	for (const f of dsFiles) {
		if (!isCoverageScanTarget(f)) continue;
		let source: string;
		try {
			source = await readFile(join(cwd, f), "utf8");
		} catch {
			continue;
		}
		warnings.push(...cvaCoverageWarnings(source, f));
	}
	return warnings;
}

/** One human-readable `⚠ …` line per coverage-loss warning. */
export function formatCvaCoverageWarning(w: CvaCoverageWarning): string {
	if (w.kind === "render-target-unresolved") {
		return `  ⚠ ${w.file} — render target unresolved: no export matches ${w.expected.join(
			" / ",
		)} (found ${w.components.join(", ")}); CVA drift rules skipped for this file`;
	}
	return `  ⚠ ${w.file} — ${w.component} props type "${w.unresolvedType}" unresolvable; axis dropped without evidence: ${w.axes.join(
		", ",
	)}`;
}
