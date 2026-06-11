import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../lib/config.js";
import { runCompletenessCheck } from "../lib/doctor/completeness.js";
import { type DoctorResult, renderMarkdown } from "../lib/doctor/render.js";
import { renderVerifyTable, verifyHooks } from "../lib/doctor/verify-hooks.js";
import { openCount, parseExceptions } from "../lib/exceptions.js";
import { detectBuildCommand, printNextStep } from "../lib/log.js";
import { detectLookalikes } from "../lib/lookalike.js";
import { parseManifest } from "../lib/manifest.js";
import { computeVerificationChain, runMigrations } from "../lib/migration-framework.js";
import { MIGRATION_REGISTRY } from "../lib/migration-registry.js";
import { detectPackageManager } from "../lib/package-manager.js";
import { resolveManifestPath } from "../lib/paths.js";
import { loadPreAdoptProject, loadProject, type ProjectContext } from "../lib/project.js";
import {
	type CvaCoverageWarning,
	formatCvaCoverageWarning,
	scanCvaCoverage,
} from "../lib/reports/cva-coverage.js";
import { scanRootDupes } from "../lib/root-dupes.js";
import { checkVersionCurrency } from "../lib/version-currency.js";
import { cliVersion, LABEL_CLI, LABEL_PIN } from "../lib/version-vocab.js";

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

export async function doctorCmd(opts: {
	pack?: string;
	ignore?: string;
	cwd?: string;
	verifyHooks?: boolean;
	completeness?: boolean;
	json?: boolean;
	verbose?: boolean;
}): Promise<void> {
	const verbose = opts.verbose ?? false;
	if (opts.completeness) {
		await runCompletenessCheck({ pack: opts.pack, cwd: opts.cwd });
		return;
	}
	const cwd = opts.cwd ?? process.cwd();
	let pack = opts.pack;
	if (!pack) {
		const cfgPath = join(cwd, ".claude-ds.json");
		if (!(await exists(cfgPath))) {
			process.stderr.write("error: --pack required (no .claude-ds.json found)\n");
			process.exit(2);
		}
		const cfg = parseConfig(await readFile(cfgPath, "utf8"));
		pack = cfg.pack;
	}
	const here = dirname(fileURLToPath(import.meta.url));
	const repoRoot = resolve(here, "..", "..");
	const packDir = join(repoRoot, "packs", pack);

	if (opts.verifyHooks) {
		const results = await verifyHooks(packDir, cwd);
		const table = renderVerifyTable(results);
		process.stdout.write(table);
		const anyFail = results.some((r) => r.status === "FAIL");
		// #349 F21: every command ends with a → Next breadcrumb. A failed hook
		// means the scaffold is broken — sync re-installs the pack files; a
		// clean hook-verify routes back to the day-to-day build hint.
		const buildCmd = await detectBuildCommand(cwd);
		printNextStep("doctor", {
			doctorVerdict: anyFail ? "scaffold-gap" : "clean",
			buildCmd,
		});
		if (anyFail) process.exit(1);
		return;
	}

	const manifestRaw = await readFile(join(packDir, "manifest.json"), "utf8");
	const manifest = parseManifest(manifestRaw);

	// Resolve appDir + lookalike-ignore via `ProjectContext` so doctor reads the
	// same `ctx.auditConfig.appDir` the audit command does — healing the prior
	// "audit detects src/app fall-through, doctor uses cfg.app_dir only" divergence
	// (PRD #266 Problem #2). The pre-adopt branch mints a real frozen ctx via
	// `loadPreAdoptProject` so the resolver — not a direct `detectAppDir` call —
	// owns the src/app detection that #58 introduced.
	const configPath = join(cwd, ".claude-ds.json");
	const isPostAdopt = await exists(configPath);
	let ctx: ProjectContext;
	if (isPostAdopt) {
		try {
			// loadProject handles the #47/#34 backfill + persist of app_dir / claude_md_target.
			ctx = await loadProject(cwd);
		} catch {
			// Malformed config — fall back to pre-adopt resolution so doctor still runs.
			ctx = await loadPreAdoptProject(cwd, { pack, packDir, manifest });
		}
	} else {
		ctx = await loadPreAdoptProject(cwd, { pack, packDir, manifest });
	}
	const { appDir } = ctx.auditConfig;
	// `lookalike_ignore` is not in the audit-config bundle (it is doctor-specific,
	// not shared with detect/classify/fix). Only the adopted ctx has a full cfg.
	const configIgnore: string[] = ctx.kind === "adopted" ? ctx.cfg.lookalike_ignore : [];

	// Resolve canonical paths through app_dir for the fs existence check (#58).
	// app/* → <app_dir>/* so src/app projects don't false-positive.
	// We pass resolved paths to detectLookalikes, then remap Finding.canonical back
	// to the original manifest path for display (output stays grep-friendly with app/).
	const resolvedToManifest = new Map<string, string>();
	const resolvedCanonicalPaths = manifest.canonical_paths.map((p) => {
		const resolved = resolveManifestPath(p, appDir);
		resolvedToManifest.set(resolved, p);
		return resolved;
	});

	const flagGlobs = opts.ignore
		? opts.ignore
				.split(",")
				.map((g) => g.trim())
				.filter(Boolean)
		: [];
	const ignoreGlobs = [...manifest.lookalike_ignore, ...configIgnore, ...flagGlobs];

	const rawFindings = await detectLookalikes(cwd, resolvedCanonicalPaths, ignoreGlobs);
	// Remap resolved paths back to manifest-canonical display paths.
	const findings = rawFindings.map((f) => ({
		...f,
		canonical: resolvedToManifest.get(f.canonical) ?? f.canonical,
	}));
	const pm = await detectPackageManager(cwd);

	// #23: scan for root-level dupes of canonical design-system/ files
	const rootDupes = await scanRootDupes(cwd, manifest.deprecated_paths);

	// Coverage-loss diagnostics (#570): surface silent CVA coverage shrink —
	// unresolvable props types and failed render-target resolution. Informational
	// (does not flip the exit code, like upgrade/repair); makes "the rule went
	// quiet" distinguishable from "nothing is wrong".
	const coverageWarnings: CvaCoverageWarning[] = await scanCvaCoverage(ctx);

	let result: DoctorResult;

	if (ctx.kind === "adopted") {
		// Post-adopt: check drift (missing managed files + exception count)
		const cfg = ctx.cfg;
		let openExceptions = 0;
		const exceptionsPath = join(cwd, "design-system/exceptions.json");
		if (await exists(exceptionsPath)) {
			try {
				const ex = parseExceptions(await readFile(exceptionsPath, "utf8"));
				openExceptions = openCount(ex);
			} catch {
				// Seeded exceptions.json may be empty/stub — treat as 0 exceptions
				openExceptions = 0;
			}
		}

		// Check which managed files are missing.
		// Resolve through app_dir so src/app projects (#58) don't false-positive.
		// Store the manifest path for display; check the resolved path on disk.
		const managedFiles = manifest.files.filter((f) => f.category === "managed");
		const missingManaged: string[] = [];
		for (const f of managedFiles) {
			const resolvedPath = resolveManifestPath(f.path, appDir);
			if (!(await exists(join(cwd, resolvedPath)))) missingManaged.push(f.path);
		}

		result = {
			mode: "post-adopt",
			canonical: findings,
			drift: {
				missing: missingManaged,
				open_exceptions: openExceptions,
			},
			packageManager: pm,
			rootDupes: rootDupes.length > 0 ? rootDupes : undefined,
		};

		// Suppress unused variable warning
		void cfg;
	} else {
		result = {
			mode: "pre-adopt",
			canonical: findings,
			packageManager: pm,
			rootDupes: rootDupes.length > 0 ? rootDupes : undefined,
		};
	}

	// #349 F16: aggregate scaffold-gap + open-exceptions + repair-needed +
	// upgrade-available into the health verdict so a clean all-clear isn't
	// blind to what upgrade/repair would act on. Both signals require an
	// adopted project (a parsed config carries `packVersion`); pre-adopt
	// doctor leaves them at zero.
	let upgradeAvailable = false;
	let repairNeeded = 0;
	if (ctx.kind === "adopted") {
		upgradeAvailable = checkVersionCurrency({
			pinned: ctx.cfg.packVersion,
			installed: cliVersion(),
		}).upgradeAvailable;

		// Repair-needed = N regressed migration end-states at the current
		// packVersion. Same dry-run check `upgrade` already uses — every
		// migration's `plan()` is idempotent and re-emits its Changes when the
		// end-state drifted (the meta_kind_strict regression #300 closed). A
		// failure here is a doctor concern, not a hard exit, so swallow plan
		// errors and report "0 repaired" rather than crashing the verdict.
		try {
			const verifyChain = computeVerificationChain(ctx.cfg.packVersion, MIGRATION_REGISTRY);
			if (verifyChain.length > 0) {
				const dryReport = await runMigrations(ctx, verifyChain, "dry-run");
				repairNeeded = dryReport.ops.filter((o) => o.changes.length > 0).length;
			}
		} catch {
			// Best-effort: keep doctor running even if the verification chain
			// hits a plan error. The next `upgrade` invocation will surface the
			// failure with its own error path.
		}
	}

	// PRD #340 sub-issue #344: doctor no longer emits both unconditionally.
	// `--json` selects the machine surface; default is the human checklist.
	// Pre-#344 every invocation dumped both. The verdict aggregation above
	// still runs in both modes — it feeds the exit code, not just the render.
	//
	// Issue #408: under `--json` we defer the emit until the verdict is
	// computed below so the headless contract envelope can wrap the existing
	// DoctorResult shape. Non-JSON mode still emits the markdown checklist
	// here, byte-identical to today.
	if (!opts.json) {
		process.stdout.write(renderMarkdown(result, verbose));
	}

	// Exit 1 if any findings: lookalikes present, managed files missing, or root dupes detected (#23)
	const hasLookalikes = findings.some((f) => !f.present && f.lookalike !== null);
	const hasMissingManaged = (result.drift && result.drift.missing.length > 0) === true;
	const hasRootDupes = rootDupes.length > 0;
	const openExceptions = result.drift?.open_exceptions ?? 0;

	// #349 F16: render the health verdict — one line per aggregated signal.
	// Picks the doctor's "verdict kind" (used by the breadcrumb below) by a
	// scaffold-first priority: scaffold, then root-dupes, then upgrade/repair,
	// then clean — the same structural-integrity-before-version ordering the
	// shared remediation planner (`planRemediation`, ADR-0018) sequences.
	//
	// Pre-adopt mode collapses to a single "Not yet adopted" verdict —
	// saying "✓ All clear" + "run npm run build" while renderMarkdown
	// already says "Run adopt to install the scaffold" is the F9-style
	// contradiction this PR closes for audit. Same shape, doctor edition.
	const verdictLines: string[] = ["## Verdict", ""];
	if (ctx.kind !== "adopted") {
		verdictLines.push("- ⚠ Not yet adopted — `.claude-ds.json` absent");
		if (hasLookalikes) verdictLines.push("- ✗ Lookalikes detected — rename before `adopt`");
		if (hasRootDupes) verdictLines.push(`- ✗ Root-level duplicates: ${rootDupes.length}`);
	} else {
		if (hasLookalikes) verdictLines.push("- ✗ Lookalikes detected — rename or re-adopt");
		if (hasMissingManaged) {
			verdictLines.push(
				`- ✗ Scaffold gap: ${result.drift?.missing.length ?? 0} managed file(s) missing`,
			);
		}
		if (hasRootDupes) verdictLines.push(`- ✗ Root-level duplicates: ${rootDupes.length}`);
		if (repairNeeded > 0)
			verdictLines.push(`- ⚠ Repair needed: ${repairNeeded} regressed migration end-state(s)`);
		if (upgradeAvailable) {
			verdictLines.push(
				`- ⚠ Upgrade available: ${LABEL_PIN} ${ctx.cfg.packVersion} < ${LABEL_CLI} ${cliVersion()}`,
			);
		}
		if (openExceptions > 0) verdictLines.push(`- ℹ Open exceptions: ${openExceptions}`);

		const everythingClean =
			!hasLookalikes &&
			!hasMissingManaged &&
			!hasRootDupes &&
			repairNeeded === 0 &&
			!upgradeAvailable;
		if (everythingClean) verdictLines.push("- ✓ All clear");
	}
	// Coverage-loss diagnostics (#570) — informational, surfaced in both modes.
	// A CVA rule going quiet is not a project defect, so it does not flip the
	// exit code; it is shown so silent shrink does not pass for "nothing wrong".
	if (coverageWarnings.length > 0) {
		verdictLines.push(
			`- ⚠ Coverage-loss diagnostics: ${coverageWarnings.length} (a CVA rule went quiet, not "nothing wrong")`,
		);
		for (const w of coverageWarnings) verdictLines.push(`  ${formatCvaCoverageWarning(w).trim()}`);
	}
	verdictLines.push("");
	// #344: --json is the machine surface — suppress the human verdict block.
	if (!opts.json) process.stdout.write(verdictLines.join("\n"));

	// #349 F21: every command ends with a → Next breadcrumb. Pick the route
	// the same way the verdict ordered the concerns. Scaffold and lookalike
	// issues outrank version concerns — you do not upgrade onto a broken
	// baseline. Pre-adopt routes through `adopt` regardless: even a
	// lookalike rename is a pre-`adopt` step, not a `migrate-layout` (which
	// is an adopted-project remediation).
	const buildCmd = await detectBuildCommand(cwd);
	const verdict:
		| "clean"
		| "pre-adopt"
		| "scaffold-gap"
		| "root-dupes"
		| "lookalikes"
		| "repair-needed"
		| "upgrade-available" =
		ctx.kind !== "adopted"
			? "pre-adopt"
			: hasMissingManaged
				? "scaffold-gap"
				: hasRootDupes
					? "root-dupes"
					: hasLookalikes
						? "lookalikes"
						: repairNeeded > 0
							? "repair-needed"
							: upgradeAvailable
								? "upgrade-available"
								: "clean";
	// #344: --json suppresses the human → Next breadcrumb too.
	if (!opts.json) printNextStep("doctor", { doctorVerdict: verdict, buildCmd });

	// F16: failing the verdict on upgrade-available or repair-needed would
	// be more aggressive than F16 demands ("not blind to" ≠ "fail the
	// exit"). Keep today's exit-1 gates (lookalikes / scaffold gap / root
	// dupes) — those are project-defect signals — and let upgrade-available
	// / repair-needed surface in the verdict + breadcrumb without flipping
	// the exit code. Tests pin both behaviors.
	const failing = hasLookalikes || hasMissingManaged || hasRootDupes;
	if (failing) {
		if (hasLookalikes) {
			process.stderr.write(
				"If these matches are false positives, re-run with --ignore '<glob>,<glob>'\n",
			);
		}
		if (hasRootDupes) {
			process.stderr.write("Root-level duplicates detected — run `reconcile` to resolve\n");
		}
	}

	// Issue #408: emit the headless contract envelope around the existing
	// DoctorResult shape so a verifying agent can route on `verdict`/`ok`/
	// `exitCode` without reparsing the markdown. Top-level `mode`,
	// `canonical`, `drift`, etc. are preserved for back-compat with PRD
	// #340 sub-issue #344's machine surface (pinned by doctor.test.ts).
	if (opts.json) {
		const exitCode = failing ? 1 : 0;
		const headlessEnvelope = {
			command: "doctor" as const,
			ok: !failing,
			verdict,
			exitCode,
			actions: {},
			remaining: {
				missingManaged: result.drift?.missing ?? [],
				lookalikes: findings.filter((f) => !f.present && f.lookalike !== null).length,
				rootDupes: rootDupes.length,
				repairNeeded,
				upgradeAvailable,
				openExceptions,
				coverageWarnings,
			},
			...result,
		};
		process.stdout.write(JSON.stringify(headlessEnvelope, null, 2) + "\n");
		process.exit(exitCode);
	}

	if (failing) {
		process.exit(1);
	}
}
