import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DriftFinding } from "../drift/index.js";
import {
	evaluateIntegrity,
	type IntegrityFinding,
	isIntegrityBlocking,
} from "../integrity/index.js";
import type { ProjectContext } from "../project.js";
import { checkThreeSignals } from "../three-signal.js";
import { walkDir } from "./unexpected-files.js";

export type AuditFinding = DriftFinding | IntegrityFinding;

export interface DriftIntegrityReport {
	/** All findings — drift + integrity — in scan order. Includes non-blocking integrity. */
	findings: AuditFinding[];
	/** Files whose blocking integrity check failed; drift was intentionally skipped on them. */
	integrityFailedFiles: Set<string>;
	/** Files we attempted to scan (read source for). */
	scannedFiles: Set<string>;
	/** Files that produced at least one finding. */
	filesWithFindings: Set<string>;
	/** Project-relative .tsx files under the tier dirs that we scanned. */
	tierDirEntries: string[];
	/** Tier dirs the scan covered — passes through to the orchestrator for the coverage log. */
	tierDirs: readonly string[];
	/** Pre-formatted "evaluated N file(s) across K tier directories…" line for the orchestrator. */
	coverageLine: string;
}

const DRIFT_TIER_DIRS = [
	"design-system/atoms",
	"design-system/composites",
	"design-system/patterns",
];

/**
 * Walk the DS tier dirs (atoms, composites, patterns) plus references/,
 * evaluate integrity, then run the three-signal drift check on files that
 * passed integrity. Pure read — no writes, no printing.
 *
 * Files that fail blocking integrity (anything other than UNRESOLVABLE-IMPORT)
 * have their drift check skipped, matching the audit command's prior behavior:
 * integrity is gating, drift is downstream.
 *
 * Reads `ctx.auditConfig` — the one resolved source of truth — for everything
 * the integrity context + the drift check need (PRD #266 Phase B). The old
 * per-call opts bag is gone.
 */
export async function scanDriftAndIntegrity(ctx: ProjectContext): Promise<DriftIntegrityReport> {
	const { cwd } = ctx;

	const findings: AuditFinding[] = [];
	const integrityFailedFiles = new Set<string>();
	const scannedFiles = new Set<string>();
	const filesWithFindings = new Set<string>();

	const dsFiles = await walkDir(cwd, "design-system");
	const tierDirEntries: string[] = [];
	for (const f of dsFiles) {
		if (!f.endsWith(".tsx")) continue;
		if (f.endsWith(".showcase.tsx") || f.endsWith(".test.tsx") || f.endsWith(".stories.tsx"))
			continue;
		const subPath = f.slice("design-system/".length);
		const inTierDir = DRIFT_TIER_DIRS.some(
			(d) => f.startsWith(`${d}/`) && !subPath.slice(subPath.indexOf("/") + 1).includes("/"),
		);
		const inReferencesDir =
			f.startsWith("design-system/references/") &&
			!subPath.slice("references/".length).includes("/");
		if (inTierDir || inReferencesDir) tierDirEntries.push(f);
	}

	for (const filePath of tierDirEntries) {
		let source: string;
		try {
			source = await readFile(join(cwd, filePath), "utf8");
		} catch {
			continue;
		}
		scannedFiles.add(filePath);

		const integrityFindings = await evaluateIntegrity(filePath, source, ctx);
		const blockingIntegrity = integrityFindings.filter((f) => isIntegrityBlocking(f.ruleId));
		const nonBlockingIntegrity = integrityFindings.filter((f) => !isIntegrityBlocking(f.ruleId));
		findings.push(...nonBlockingIntegrity);
		for (const f of nonBlockingIntegrity) filesWithFindings.add(f.file);
		if (blockingIntegrity.length > 0) {
			findings.push(...blockingIntegrity);
			for (const f of blockingIntegrity) filesWithFindings.add(f.file);
			integrityFailedFiles.add(filePath);
			continue;
		}

		const { findings: driftFindings } = checkThreeSignals(filePath, source, ctx);
		findings.push(...driftFindings);
		for (const f of driftFindings) filesWithFindings.add(f.file);
	}

	const cleanCount = scannedFiles.size - filesWithFindings.size;
	const coverageLine = `evaluated ${scannedFiles.size} file(s) across ${DRIFT_TIER_DIRS.length} tier directories (${cleanCount} clean, ${filesWithFindings.size} with findings)`;

	return {
		findings,
		integrityFailedFiles,
		scannedFiles,
		filesWithFindings,
		tierDirEntries,
		tierDirs: DRIFT_TIER_DIRS,
		coverageLine,
	};
}
