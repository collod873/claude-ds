import { execFile as execFileCb } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkCleanTree } from "../lib/clean-tree.js";
import { colors, confirm, err, info, printNextStep } from "../lib/log.js";
import { detectLookalikes } from "../lib/lookalike.js";
import { type Manifest, parseManifest } from "../lib/manifest.js";
import type { Change, Operation } from "../lib/operation.js";
import { loadPreAdoptProject, loadProject, type ProjectContext } from "../lib/project.js";
import { run } from "../lib/runner.js";

const execFile = promisify(execFileCb);

async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

export async function migrateLayoutCmd(opts: {
	pack?: string;
	yes?: boolean;
	ignore?: string;
	/** Bypass the clean-tree guard (PRD #325 / sub-issue #328). */
	allowDirty?: boolean;
	cwd?: string;
}) {
	const cwd = opts.cwd ?? process.cwd();
	const c = colors();

	// Refuse if not inside a git repo. migrate-layout relies on `git mv` to
	// preserve history on the renames, and the clean-tree guard upstream gives
	// the consumer "git is the undo" by default (ADR-0023). A git repo is the
	// hard precondition — the shared clean-tree guard treats a missing repo as
	// "cannot check" and proceeds, which would silently break that affordance.
	try {
		await execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
	} catch {
		process.stderr.write(`${c.red("migrate-layout: not inside a git repo")}\n`);
		process.exit(2);
	}

	// Shared clean-tree guard (PRD #325 / sub-issue #328). Replaces the
	// hand-rolled `git status --porcelain` check this command used to carry.
	const guard = checkCleanTree({ command: "migrate-layout", cwd, allowDirty: opts.allowDirty });
	if (!guard.ok) {
		process.stderr.write(`${c.red(guard.message)}\n`);
		process.exit(2);
	}

	// Resolve pack + manifest. Prefer loadProject when there's a config (no
	// migration side effect now — #84 — so the clean-tree precondition holds).
	// Fall back to --pack with `loadPreAdoptProject` when adopt hasn't run, so
	// the Runner always sees a real frozen ctx (no fabricated cast).
	let pack: string;
	let packDir: string;
	let manifest: Manifest;
	let ctx: ProjectContext;
	const cfgPath = join(cwd, ".claude-ds.json");
	if (await exists(cfgPath)) {
		const baseCtx = await loadProject(cwd);
		pack = opts.pack ?? baseCtx.cfg.pack;
		if (pack === baseCtx.cfg.pack) {
			packDir = baseCtx.packDir;
			manifest = baseCtx.manifest;
			ctx = baseCtx;
		} else {
			const here = dirname(fileURLToPath(import.meta.url));
			const repoRoot = resolve(here, "..", "..");
			packDir = join(repoRoot, "packs", pack);
			manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
			ctx = await loadPreAdoptProject(cwd, { pack, packDir, manifest });
		}
	} else {
		if (!opts.pack) {
			err(c.red("--pack required (no .claude-ds.json found)"));
			process.exit(2);
		}
		pack = opts.pack;
		const here = dirname(fileURLToPath(import.meta.url));
		const repoRoot = resolve(here, "..", "..");
		packDir = join(repoRoot, "packs", pack);
		manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
		ctx = await loadPreAdoptProject(cwd, { pack, packDir, manifest });
	}

	const flagGlobs = opts.ignore
		? opts.ignore
				.split(",")
				.map((g) => g.trim())
				.filter(Boolean)
		: [];
	const ignoreGlobs = [...manifest.lookalike_ignore, ...flagGlobs];

	const findings = await detectLookalikes(cwd, manifest.canonical_paths, ignoreGlobs);

	// Only rename file→file pairs. Skip canonicals that are directories (no extension, no dot in basename).
	// Deduplicate: a lookalike source can only be consumed once (first canonical wins).
	const usedSources = new Set<string>();
	const renames: { from: string; to: string }[] = [];
	for (const f of findings) {
		if (f.present || f.lookalike === null) continue;
		// Skip directory-style canonicals (no file extension and no dot after last slash)
		const canonicalBase = f.canonical.split("/").pop() ?? f.canonical;
		if (!canonicalBase.includes(".")) continue;
		if (usedSources.has(f.lookalike)) continue;
		usedSources.add(f.lookalike);
		renames.push({ from: f.lookalike, to: f.canonical });
	}

	if (renames.length === 0) {
		info(c.dim("nothing to migrate"));
		// #363: even the no-op path ends with the breadcrumb. Same routing as the
		// success path — adopted → heal, pre-adopt → adopt — so the consumer's
		// next move doesn't depend on whether migrate-layout found anything.
		printNextStep("migrate-layout", { projectKind: ctx.kind });
		return;
	}

	// Print plan. Bold heading + dim arrows so the canonical destination is
	// visually distinct from the source on a TTY; bytes off-TTY are unchanged.
	process.stdout.write(`${c.bold("Rename plan:")}\n`);
	for (const r of renames) {
		process.stdout.write(`  ${r.from} ${c.dim("→")} ${c.cyan(r.to)}\n`);
	}
	process.stdout.write("\n");

	if (!opts.yes && !(await confirm("Apply renames with git mv?"))) {
		err(c.red("aborted"));
		process.exit(130);
	}

	const renamesOp: Operation = {
		name: "migrate-layout-renames",
		async plan(): Promise<Change[]> {
			return renames.map((r) => ({ kind: "rename", path: r.from, after: r.to }));
		},
	};
	const report = await run(ctx, [renamesOp], "apply");
	if (report.failed) {
		err(c.red(`migrate-layout failed: ${report.failed.error}`));
		process.exit(2);
	}

	// #359: do NOT auto-commit. The Runner's `git mv` stages the renames in the
	// index, so the consumer can review `git status`, amend, or back out with a
	// single `git reset` — the "git is the undo" affordance the clean-tree
	// guard exists to provide. Baking the renames into history immediately (the
	// old behavior) defeated that and required `git reset --hard HEAD~1` to
	// back out, which is exactly the destructive operation we steer consumers
	// away from.
	info(
		c.green(
			`migrated ${renames.length} file(s) — renames are staged in the git index; review with 'git status' and commit when ready`,
		),
	);
	printNextStep("migrate-layout", { projectKind: ctx.kind });
}
