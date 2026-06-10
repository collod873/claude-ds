import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	type CommandResult,
	commandError,
	findingsRemain,
	success,
} from "../lib/command-result.js";
import { emitHeadless, errorResult, HEADLESS_EXIT } from "../lib/headless.js";
import { err, info, setJsonMode } from "../lib/log.js";
import { parseManifest } from "../lib/manifest.js";

const execFile = promisify(execFileCb);

import { checkCleanTree } from "../lib/clean-tree.js";
import { detectFormatter, runFormatter } from "../lib/formatter.js";
import { migrateConfig } from "../lib/ops/migrate-config.js";
import { makeSyncPackFiles } from "../lib/ops/sync-pack-files.js";
import { loadProject } from "../lib/project.js";
import { runConsumerVerify, type VerifyResult } from "../lib/run-consumer-verify.js";
import { run } from "../lib/runner.js";

export async function syncCmd(opts: {
	offlineFixture?: string;
	cwd?: string;
	yes?: boolean;
	dryRun?: boolean;
	allowDirty?: boolean;
	json?: boolean;
	verbose?: boolean;
	verify?: boolean;
}): Promise<CommandResult> {
	const cwd = opts.cwd ?? process.cwd();
	const verbose = opts.verbose ?? false;
	if (opts.json) setJsonMode(true);
	try {
		await stat(join(cwd, ".claude-ds.json"));
	} catch {
		const m = ".claude-ds.json absent";
		err(m);
		if (opts.json) emitHeadless(errorResult("sync", m));
		return commandError(2);
	}

	// Clean-tree guard (PRD #325 / sub-issue #328). --dry-run never mutates so
	// it bypasses the gate; the apply path refuses on a dirty tree unless the
	// caller passes --allow-dirty (or heal forwards it).
	if (!opts.dryRun) {
		const guard = checkCleanTree({ command: "sync", cwd, allowDirty: opts.allowDirty });
		if (!guard.ok) {
			err(guard.message);
			if (opts.json) emitHeadless(errorResult("sync", guard.message));
			return commandError(2);
		}
	}

	// #84: apply migrateConfig before planning the pack-file sync, so syncPackFiles
	// plans against the post-migration cfg (correct app_dir / claude_md_target).
	// Previously this was a hidden side effect of loadConfigWithMigration during boot;
	// now it's a deliberate, visible Change applied via the Runner. The migration
	// is reported in the standard preview format below.
	{
		const preCtx = await loadProject(cwd);
		const migrationReport = await run(preCtx, [migrateConfig], "apply");
		for (const c of migrationReport.applied) {
			if (c.kind === "write" && c.path === ".claude-ds.json") {
				info("migrate-config: .claude-ds.json updated to v0.6 shape (app_dir / claude_md_target)");
			}
		}
		if (migrationReport.failed) {
			const m = `migrate-config failed: ${migrationReport.failed.error}`;
			err(m);
			if (opts.json) emitHeadless(errorResult("sync", m));
			return commandError(2);
		}
	}

	const ctx = await loadProject(cwd);
	const cfg = ctx.cfg;

	// Version is always the consumer's packVersion — never fetched from remote tags.
	const target = cfg.packVersion;
	const opOpts: Parameters<typeof makeSyncPackFiles>[0] = {};
	if (opts.offlineFixture) {
		const here = dirname(fileURLToPath(import.meta.url));
		const repoRoot = resolve(here, "..", "..");
		opOpts.packDir = resolve(repoRoot, opts.offlineFixture);
		opOpts.manifest = parseManifest(await readFile(join(opOpts.packDir, "manifest.json"), "utf8"));
	}

	// Plan once. The Op's plan() returns its decisions in the typed outcome arm of
	// its PlanResult — sync renders the preview from there. The Runner is the only
	// thing that writes; we just stage Changes here. Plan is cached internally so
	// the apply path below does not re-run diffFile.
	const op = makeSyncPackFiles(opOpts);
	const planResult = await op.plan(ctx);
	const decisions = planResult.outcome.decisions;

	// Render preview in the existing user-facing format (tests assert on these labels).
	// #450: by default the per-file `skip: <path> — …` lines are a ~40-line wall
	// that buries the one `rewrite:` line that actually matters. Keep every
	// action line (rewrite/create/abort/rewrite-region) visible; collapse the
	// no-op `skip` decisions to a per-reason count. --verbose lists them all.
	if (verbose) {
		for (const d of decisions) {
			info(`${d.displayAction}: ${d.displayPath} — ${d.verdict.reason}`);
		}
	} else {
		const skips: typeof decisions = [];
		for (const d of decisions) {
			if (d.verdict.action === "skip") {
				skips.push(d);
				continue;
			}
			info(`${d.displayAction}: ${d.displayPath} — ${d.verdict.reason}`);
		}
		if (skips.length > 0) {
			const byReason = new Map<string, number>();
			for (const d of skips)
				byReason.set(d.verdict.reason, (byReason.get(d.verdict.reason) ?? 0) + 1);
			const breakdown = [...byReason.entries()]
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([reason, n]) => `${n} ${reason}`)
				.join(", ");
			info(
				`skipped ${skips.length} file${skips.length === 1 ? "" : "s"} already in sync (${breakdown}) — re-run with --verbose to list them`,
			);
		}
	}

	// #18d: summarise whether .claude-ds.json config keys (aside from packVersion) will change.
	{
		const nonVersionKeys = Object.keys(cfg).filter((k) => k !== "packVersion") as Array<
			keyof typeof cfg
		>;
		const nextVersion = target;
		const changedKeys = nonVersionKeys.filter(
			(k) => JSON.stringify(cfg[k]) !== JSON.stringify({ ...cfg, packVersion: nextVersion }[k]),
		);
		if (changedKeys.length > 0) {
			info(`config will change: ${changedKeys.join(", ")}`);
		} else {
			info("config unchanged");
		}
	}

	if (opts.dryRun) {
		info("[dry-run] planned changes shown above — no files modified");
		if (opts.json) {
			emitHeadless({
				command: "sync",
				ok: true,
				verdict: "dry-run",
				exitCode: HEADLESS_EXIT.OK,
				actions: { dryRun: true, planned: decisions.length },
				remaining: { target },
			});
		}
		return success();
	}

	// Apply via the Runner. Plan is cached so this does not re-run diffFile.
	const report = await run(ctx, [op], "apply");

	// Surface aborts in the existing format (Runner records them; we report them).
	for (const d of decisions) {
		if (d.verdict.action === "abort")
			err(`skipped (abort): ${d.manifestPath} — ${d.verdict.reason}`);
	}
	if (report.failed) {
		const m = `apply failed at ${report.failed.change.kind}: ${report.failed.error}`;
		err(m);
		if (opts.json) emitHeadless(errorResult("sync", m));
		return commandError(2);
	}

	// #15: hook/script chmod is now a `Change.mode: "executable"` hint applied by the Runner
	// (#221 / #230). Sync only collects rewritten paths here for the formatter pass.
	// #493: paths the Op already formatted in-memory (the `app/` showcase chrome)
	// are excluded — they're consumer-formatted before staging, so re-running the
	// batch over them is wasted work (and would double-format under a stdin filter).
	const alreadyFormatted = new Set(planResult.outcome.formattedPaths);
	const rewrittenPaths: string[] = [];
	for (const c of report.applied) {
		if (c.kind !== "write") continue;
		if (alreadyFormatted.has(c.path)) continue;
		rewrittenPaths.push(c.path);
	}

	// #54: format rewritten files with the consumer's formatter (biome or prettier) if detected.
	const formatter = await detectFormatter(cwd);
	if (formatter && rewrittenPaths.length > 0) {
		await runFormatter(formatter, rewrittenPaths, cwd);
	}

	const buildScript = join(cwd, "scripts", "build-manifest.ts");
	if (existsSync(buildScript)) {
		try {
			await execFile("node", ["--experimental-strip-types", buildScript], {
				cwd,
				timeout: 30_000,
			});
			info("regenerated design-system/manifest.generated.ts");
		} catch (e: unknown) {
			const exitCode = (e as { code?: number }).code ?? "?";
			info(
				`warning: build-manifest failed (exit ${exitCode}). Run manually: node --experimental-strip-types scripts/build-manifest.ts`,
			);
		}
	}

	// Collect what we wrote so the verify gate (#410) treats those files as
	// scaffold paths even when they live outside `design-system/` (e.g.
	// `.claude/hooks/*`).
	const touchedFiles = new Set<string>();
	for (const c of report.applied) {
		if (c.kind === "write" || c.kind === "delete") touchedFiles.add(c.path);
		else if (c.kind === "rename") {
			touchedFiles.add(c.path);
			touchedFiles.add(c.after);
		}
	}
	const writes = report.applied.filter((c) => c.kind === "write").length;
	const aborts = decisions.filter((d) => d.verdict.action === "abort").length;
	const inSync = writes === 0 && aborts === 0;

	// Verify gate (#410 / PRD #407). Caller-owned (issue #437 / ADR-0018): the
	// CLI entry opts in via `verify: true` for a standalone `claude-ds sync`; the
	// remediation driver omits it because heal owns the single authoritative gate
	// at convergence — running it per inner step would mean N tsc invocations per
	// heal iteration. Runs only when sync actually wrote bytes. The gate fails
	// loud on errors in scaffold/touched files and reports pre-existing consumer
	// errors as warn-only.
	let verify: VerifyResult | undefined;
	if (opts.verify && !inSync) {
		const cfgCtx = await loadProject(cwd);
		verify = await runConsumerVerify(cwd, {
			managedFiles: new Set(cfgCtx.manifest.files.map((f) => f.path)),
			touchedFiles,
			managedRoots: ["design-system/"],
		});
		if (!verify.ok) {
			reportRedGate(verify);
			if (opts.json) {
				emitHeadless({
					command: "sync",
					ok: false,
					verdict: "verify-failed",
					exitCode: HEADLESS_EXIT.FINDINGS,
					actions: { filesWritten: writes, aborts, target },
					remaining: { brownfield: false, verify: verifyJson(verify) },
				});
			}
			return findingsRemain();
		}
	}

	info(`sync complete → ${target}${verify ? ` (verified via ${verify.command})` : ""}`);
	const brownfield = await hasConsumerTierFiles(cwd);

	if (opts.json) {
		emitHeadless({
			command: "sync",
			ok: true,
			verdict: inSync ? "in-sync" : "applied",
			exitCode: HEADLESS_EXIT.OK,
			actions: { filesWritten: writes, aborts, target },
			remaining: { brownfield, ...(verify ? { verify: verifyJson(verify) } : {}) },
		});
	}

	// The `→ Next` breadcrumb is caller-owned (issue #437 / ADR-0018): return it
	// for the CLI to render and the driver to discard. Suppressed under --json
	// (machine surface) by leaving the hint off.
	return success(opts.json ? undefined : { command: "sync", ctx: { brownfield } });
}

/** Surface scaffold errors on stderr. */
function reportRedGate(verify: VerifyResult): void {
	if (verify.scaffoldErrors.length > 0) {
		err(
			`verify gate failed: ${verify.command} reported ${verify.scaffoldErrors.length} error(s) in claude-ds-managed files`,
		);
		for (const e of verify.scaffoldErrors.slice(0, 20)) {
			err(`  ${e.file}:${e.line}:${e.col}  ${e.code}: ${e.message}`);
		}
		if (verify.scaffoldErrors.length > 20) {
			err(`  …and ${verify.scaffoldErrors.length - 20} more`);
		}
	} else {
		// Timeout or non-tsc failure (Biome/eslint/vitest) — no parseable TS
		// errors. The reason + output tail keep the failure diagnosable (#494).
		err(`verify gate failed: ${verify.reason ?? `${verify.command} exited ${verify.exitCode}`}`);
	}
	if (verify.outputTail) {
		err("  ── verify output (tail) ──");
		for (const line of verify.outputTail.split("\n")) {
			err(`  ${line}`);
		}
	}
	if (verify.consumerErrors.length > 0) {
		err(
			`(also ${verify.consumerErrors.length} pre-existing consumer error(s) outside claude-ds's scope)`,
		);
	}
}

function verifyJson(verify: VerifyResult): Record<string, unknown> {
	return {
		ok: verify.ok,
		command: verify.command,
		exitCode: verify.exitCode,
		timedOut: verify.timedOut,
		scaffoldErrorCount: verify.scaffoldErrors.length,
		consumerErrorCount: verify.consumerErrors.length,
		scaffoldErrors: verify.scaffoldErrors.slice(0, 20).map((e) => ({
			file: e.file,
			line: e.line,
			col: e.col,
			code: e.code,
			message: e.message,
		})),
		reason: verify.reason,
		...(verify.outputTail !== undefined ? { outputTail: verify.outputTail } : {}),
	};
}

const TIER_DIRS = [
	"design-system/atoms",
	"design-system/composites",
	"design-system/patterns",
] as const;
const COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx"];

/**
 * Brownfield = the consumer already has DS tier files for `classify` to
 * organize (PRD #241 / sub-issue #245). Surfaced via the immediate children
 * of design-system/{atoms,composites,patterns} — the same tier-dir scope the
 * audit walker uses. Nested subfolders aren't checked: they aren't classify's
 * unit of work either.
 */
async function hasConsumerTierFiles(cwd: string): Promise<boolean> {
	for (const dir of TIER_DIRS) {
		let entries;
		try {
			entries = await readdir(join(cwd, dir), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.isFile() || !e.name.endsWith(".tsx")) continue;
			if (COMPANION_SUFFIXES.some((s) => e.name.endsWith(s))) continue;
			return true;
		}
	}
	return false;
}
