/**
 * The bare-`claude-ds` front door (PRD #325 sub-issue #331; rewired in #345 /
 * ADR-0018 to be the **interactive driver of the shared remediation planner**).
 *
 * In a TTY the bare invocation:
 *   1. Runs the read-only `doctor` structural scan + drift/integrity scan and
 *      prints the "where you are / what's wrong" dashboard.
 *   2. Derives `ProjectState` and computes the remediation plan via the *same*
 *      `planRemediation` brain `heal` uses — there is no second ordering brain.
 *   3. If the plan is non-empty, presents **one commitment gate**: a preview
 *      rendered from the real planned `Change[]` (so preview counts equal what
 *      runs — F11) and a single `[Enter]`.
 *   4. On approval, **auto-advances to clean** via the shared `driveRemediation`
 *      loop with live progress, pausing inline only for genuine Ambiguities
 *      (the Decision resolver prompts on a TTY; `--answers` resolves silently).
 *
 * After the first `[Enter]` the operator never types another `claude-ds`
 * command. The retired `recommendedNext` recommender — the flat single-shot
 * `→ Next: <type this>` breadcrumb that was a second, mis-ordered brain — is
 * gone (ADR-0018).
 *
 * Non-TTY bare invocation keeps today's help-output behavior — the cli.ts entry
 * gates on `isTTY()` so this file's interactive path is only entered there. The
 * `--answers`/`interactive:false` path exists so automation (and tests) can
 * drive the loop headlessly without a pseudo-TTY.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { type Config, parseConfig } from "../lib/config.js";
import { composeDashboardState } from "../lib/dashboard.js";
import { type DriftRuleId, isExtractionNeededFinding, isFixable } from "../lib/drift/index.js";
import { type Exception, parseExceptions } from "../lib/exceptions.js";
import { buildCommitmentGate } from "../lib/gate-preview.js";
import { type IntegrityRuleId, isIntegrityFixable } from "../lib/integrity/index.js";
import { detectBuildCommand } from "../lib/log.js";
import { parseManifest } from "../lib/manifest.js";
import { resolveManifestPath } from "../lib/paths.js";
import { loadPreAdoptProject, loadProject, type ProjectContext } from "../lib/project.js";
import { deriveProjectState } from "../lib/project-state.js";
import { driveRemediation } from "../lib/remediation-driver.js";
import { planRemediation } from "../lib/remediation-planner.js";
import { renderDashboard } from "../lib/render/index.js";
import { createProgress, printLines } from "../lib/render/tty-layer.js";
import { scanDriftAndIntegrity } from "../lib/reports/drift-integrity-scan.js";
import { scanScaffoldPresence } from "../lib/reports/scaffold-presence.js";
import { scanRootDupes } from "../lib/root-dupes.js";
import { checkVersionCurrency } from "../lib/version-currency.js";
import { cliVersion } from "../lib/version-vocab.js";

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

const DEFAULT_PACK = "next-react";

/** Iteration ceiling for the front door's auto-advance — same guard heal uses. */
const DEFAULT_MAX_ITERATIONS = 3;

export interface FrontDoorOpts {
	cwd?: string;
	/** When false, skip the `[Enter]` commitment gate readline (so automation and
	 *  tests don't hang on stdin). Non-interactive runs render the dashboard and
	 *  the gate preview and then stop *unless* `yes` authorizes the drive —
	 *  the preview alone changes nothing. Defaults to true. */
	interactive?: boolean;
	/** Non-interactive authorization: with `interactive: false`, drive the loop
	 *  without the `[Enter]` prompt (the headless automation path). Ignored when
	 *  `interactive` is true — there the `[Enter]` gate is the authorization. */
	yes?: boolean;
	/** Path to an `--answers` JSON file (Decision id → option index / `"defer"`).
	 *  Forwarded to the drive loop so the front door converges without a TTY —
	 *  the no-pseudo-TTY automation path (ADR-0023). */
	answers?: string;
	/** Override the auto-advance iteration ceiling. Tests use it; default 3. */
	maxIterations?: number;
	/** C4 — when true, gate-preview renders the full one-line-per-file list
	 *  instead of the per-tier collapse. Default false. */
	verbose?: boolean;
}

export async function frontDoorCmd(opts: FrontDoorOpts): Promise<void> {
	const cwd = opts.cwd ?? process.cwd();
	const interactive = opts.interactive ?? true;

	// Mode detection mirrors `audit` / `doctor`: presence of `.claude-ds.json`
	// discriminates the boot path. A malformed config falls back to pre-adopt
	// so the dashboard never crashes on a broken project — the user can still
	// read the recommendation and recover.
	const cfgPath = join(cwd, ".claude-ds.json");
	const hasCfg = await exists(cfgPath);
	let pack = DEFAULT_PACK;
	let parsedCfg: Config | null = null;
	if (hasCfg) {
		try {
			parsedCfg = parseConfig(await readFile(cfgPath, "utf8"));
			pack = parsedCfg.pack;
		} catch {
			// Fall back to default pack; the brain will recommend adopt anyway.
		}
	}

	const here = dirname(fileURLToPath(import.meta.url));
	const repoRoot = resolve(here, "..", "..");
	const packDir = join(repoRoot, "packs", pack);
	const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));

	let ctx: ProjectContext;
	if (hasCfg) {
		try {
			ctx = await loadProject(cwd);
		} catch {
			ctx = await loadPreAdoptProject(cwd, { pack, packDir, manifest });
		}
	} else {
		ctx = await loadPreAdoptProject(cwd, { pack, packDir, manifest });
	}

	const { appDir, claudeMdTarget } = ctx.auditConfig;

	// Scaffold presence — same scan `audit` runs, but verbose:false so the
	// returned `lines` are suppressed in favor of the dashboard's "Scaffold: N/M"
	// summary line. We only consume the structured `present`/`total`.
	const scaffold = await scanScaffoldPresence(ctx, {
		manifest,
		appDir,
		claudeMdTarget,
		verbose: false,
	});

	// Missing managed files — same shape doctor's adopted branch computes (#58
	// honors app_dir when resolving manifest paths).
	const managedFiles = manifest.files.filter((f) => f.category === "managed");
	let missingManaged = 0;
	for (const f of managedFiles) {
		const resolvedPath = resolveManifestPath(f.path, appDir);
		if (!(await exists(join(cwd, resolvedPath)))) missingManaged++;
	}

	// Root-level dupes of canonical design-system/ files (#23).
	const rootDupes = await scanRootDupes(cwd, manifest.deprecated_paths);

	// Read-only audit: skip the drift scan entirely in pre-adopt (no scaffold
	// means design-system/ likely isn't there). In adopted mode, run the same
	// drift+integrity scan `audit` uses and apply exceptions so the dashboard
	// counts match what the user would see from `audit` itself.
	let findings: Array<{ ruleId: string; file: string; message: string }> = [];
	let extractionCount = 0;
	let unfixableCount = 0;
	if (ctx.kind === "adopted") {
		const exceptionsPath = join(cwd, "design-system/exceptions.json");
		let exceptions: Exception[] = [];
		if (await exists(exceptionsPath)) {
			try {
				exceptions = parseExceptions(await readFile(exceptionsPath, "utf8"));
			} catch {
				// Malformed exceptions.json — audit catches the parse error elsewhere.
			}
		}
		const suppressed = new Set(exceptions.map((e) => `${e.rule}:${e.path}`));

		const driftIntegrity = await scanDriftAndIntegrity(ctx);
		const active = driftIntegrity.findings.filter((f) => !suppressed.has(`${f.ruleId}:${f.file}`));
		findings = active.map((f) => ({ ruleId: f.ruleId, file: f.file, message: f.message }));
		extractionCount = active.filter(isExtractionNeededFinding).length;
		unfixableCount = active.filter((f) => {
			if (isExtractionNeededFinding(f)) return true;
			if (f.ruleId.startsWith("INTEGRITY-")) {
				return !isIntegrityFixable(f.ruleId as IntegrityRuleId);
			}
			return !isFixable(f.ruleId as DriftRuleId);
		}).length;
	}

	const buildCmd = await detectBuildCommand(cwd);

	// Version currency: pinned packVersion (from .claude-ds.json) vs the
	// installed CLI version (from this package's package.json). The check
	// only matters in adopted mode — pre-adopt has no pinned version, and
	// the brain's adopt recommendation wins regardless. We consume the
	// extracted pure helper rather than shelling out to `version --check`
	// (#336 acceptance).
	let upgradeAvailable = false;
	if (ctx.kind === "adopted" && parsedCfg) {
		upgradeAvailable = checkVersionCurrency({
			pinned: parsedCfg.packVersion,
			installed: cliVersion(),
		}).upgradeAvailable;
	}

	const state = composeDashboardState({
		cwd,
		mode: ctx.kind === "adopted" ? "adopted" : "pre-adopt",
		pack,
		scaffold: { present: scaffold.present, total: scaffold.total },
		missingManaged,
		rootDupes: rootDupes.length,
		findings,
		extractionCount,
		unfixableCount,
		buildCmd,
		upgradeAvailable,
	});

	printLines(renderDashboard(state));

	// Pre-adopt is an Entry point, not a planner state (ADR-0018): `adopt` hands
	// the project *into* the loop, it isn't a loop member, and `deriveProjectState`
	// needs a loaded config the project doesn't have yet. Surface the one command
	// that gets them in and stop — there is no plan to drive.
	if (ctx.kind !== "adopted") {
		printLines([`→ Run \`claude-ds adopt --pack ${pack}\` to install the design-system scaffold.`]);
		return;
	}

	// The interactive driver of the shared planner (ADR-0018). Same brain heal
	// runs headlessly: derive state → plan. An empty plan means a fixed point.
	const projectState = await deriveProjectState(cwd);
	const plan = planRemediation(projectState);

	if (plan.length === 0) {
		printLines([
			"",
			"Nothing to remediate — the tree is clean.",
			`→ Run \`${buildCmd}\` to verify everything compiles.`,
		]);
		return;
	}

	// Commitment gate: a preview rendered from the real planned Change[] (so the
	// counts the operator approves equal what runs — F11), then a single [Enter].
	// `unfixableCount` already subsumes extraction, so it is classify's whole
	// non-overlapping share; the remainder is audit --fix's auto-fixable set.
	const gateLines = await buildCommitmentGate(
		ctx,
		plan,
		{
			classifyCount: unfixableCount,
			autoFixableCount: findings.length - unfixableCount,
		},
		{ verbose: opts.verbose },
	);
	printLines(gateLines);

	if (interactive) {
		const approved = await awaitCommitment();
		if (!approved) {
			printLines(["", "Cancelled — nothing changed."]);
			return;
		}
	} else if (!opts.yes) {
		// Non-interactive without explicit authorization: the gate preview above is
		// the whole output. Driving would mutate the tree behind the operator's
		// back, so stop — `yes: true` opts into the headless drive.
		return;
	}

	// Auto-advance to clean. No `pendingSink` → the Decision resolver prompts
	// inline on a TTY for genuine Ambiguities, resolves silently when `--answers`
	// is supplied, and fails loud non-TTY otherwise (ADR-0023). Live progress on
	// stderr; the loop never pauses for mechanical work.
	const progress = createProgress();
	try {
		const outcome = await driveRemediation({
			cwd,
			maxIterations: opts.maxIterations ?? DEFAULT_MAX_ITERATIONS,
			answers: opts.answers,
			progress,
		});
		if (outcome.kind === "converged") {
			printLines(["", "✓ Tree is clean."]);
		} else if (outcome.kind === "exhausted") {
			printLines([
				"",
				"Some findings still need attention — run `claude-ds audit` to see what remains.",
			]);
		}
	} finally {
		progress.stop();
	}
}

/**
 * The single commitment gate. Empty input (`[Enter]`) approves the whole plan;
 * any other input cancels. One prompt for the entire remediation — after it,
 * the auto-advance loop pauses only for genuine Ambiguities, never for the
 * mechanical work the gate already covered.
 */
async function awaitCommitment(): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let answer: string;
	try {
		answer = await rl.question("[Enter] to run all, anything else to cancel: ");
	} catch {
		answer = "x";
	} finally {
		rl.close();
	}
	return answer.trim() === "";
}
