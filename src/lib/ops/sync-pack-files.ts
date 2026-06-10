import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ENFORCEMENT_PATH } from "../enforcement.js";
import { applyDetectedEnforcement, detectEnforcement } from "../enforcement-detect.js";
import { formatContent, resolveConsumerFormatter } from "../formatter.js";
import type { Manifest } from "../manifest.js";
import type { Change, Operation, PlanResult } from "../operation.js";
import { resolveManifestPath } from "../paths.js";
import type { ProjectContext } from "../project.js";
import { diffFile, type FileVerdict } from "../sync-diff.js";

/**
 * Per-file decision produced by `syncPackFiles.plan()`. The sync command reads this
 * to render the existing `create: / rewrite: / skip: / abort:` preview format —
 * Change alone doesn't carry the verdict reason, so we surface it side-by-side.
 */
export interface PackFileDecision {
	manifestPath: string;
	writePath: string;
	verdict: FileVerdict;
	/** "create" | "rewrite" | "skip" | "abort" — what to show the user. */
	displayAction: string;
	/** Pretty form: `path` if unchanged, `manifestPath → writePath` if rewritten. */
	displayPath: string;
}

/** Outcome reported on `RunReport.ops[i].outcome` — per-file sync verdicts. */
export interface SyncPackFilesOutcome {
	decisions: PackFileDecision[];
	/**
	 * Consumer-relative write paths whose bytes were run through the consumer's
	 * formatter in-memory before being staged (issue #493). The sync command
	 * excludes these from its post-apply formatter batch so they aren't formatted
	 * twice; everything else it wrote still goes through the batch.
	 */
	formattedPaths: string[];
}

export type SyncPackFilesOp = Operation<SyncPackFilesOutcome>;

export interface SyncPackFilesOpts {
	/** Override the manifest used (e.g. `--offline-fixture` fixtures). Defaults to `ctx.manifest`. */
	manifest?: Manifest;
	/** Override the pack directory (e.g. `--offline-fixture`). Defaults to `ctx.packDir`. */
	packDir?: string;
}

/**
 * Build the syncPackFiles Operation. plan() walks the (possibly-overridden) manifest,
 * resolves consumer-side write paths via `resolveManifestPath` + `cfg.claude_md_target`,
 * loads upstream/current bytes, runs `diffFile`, and emits one Change per non-skip verdict
 * (or `abort` Change for hand-edited managed files — see operation.ts).
 *
 * Plan results are cached internally (per-instance) so sync can do a "plan to preview,
 * confirm, then apply" flow without re-running diffFile twice. The op is single-use:
 * re-running plan() returns the cached result.
 *
 * Per-file decisions reach the caller as the Op's typed outcome on
 * `RunReport.ops[i].outcome.decisions` — no mutable side-channel on the op handle.
 */
export function makeSyncPackFiles(opts: SyncPackFilesOpts = {}): SyncPackFilesOp {
	let cached: {
		changes: Change[];
		decisions: PackFileDecision[];
		formattedPaths: string[];
	} | null = null;
	return {
		name: "sync-pack-files",
		async plan(ctx: ProjectContext): Promise<PlanResult<SyncPackFilesOutcome>> {
			if (cached) {
				return {
					changes: cached.changes,
					outcome: { decisions: cached.decisions, formattedPaths: cached.formattedPaths },
				};
			}
			const manifest = opts.manifest ?? ctx.manifest;
			const packDir = opts.packDir ?? ctx.packDir;
			const cfg = ctx.cfg;

			// #493: the showcase chrome under `app/` lands in the consumer's
			// app_dir — linted territory. Format the canonical bytes through the
			// consumer's formatter *before* diffing and writing, so (a) what we
			// stage already passes their lint and (b) `diffFile` compares like
			// against like — a previously-formatted file reads as "in sync" instead
			// of ping-ponging "upstream changed" on every heal pass. Resolved once.
			const formatter = await resolveConsumerFormatter(ctx.cwd);

			const changes: Change[] = [];
			const decisions: PackFileDecision[] = [];
			const formattedPaths: string[] = [];

			for (const f of manifest.files) {
				if (f.category === "generated") continue;
				if (cfg.removed.includes(f.path)) continue;

				// #47: rewrite app/... → <app_dir>/... at I/O boundary.
				// #34: route CLAUDE.md to the configured target (default "CLAUDE.md" for back-compat).
				const writePath =
					f.path === "CLAUDE.md" ? cfg.claude_md_target : resolveManifestPath(f.path, cfg.app_dir);

				// Path-traversal guard: reject any manifest entry that escapes cwd.
				const dest = join(ctx.cwd, writePath);
				const rel = relative(ctx.cwd, dest);
				if (rel.startsWith("..") || rel === "") {
					throw new Error(`path traversal rejected: ${f.path}`);
				}

				// Pack source-name mapping: package.json ships as .seed, CLAUDE.md as .fragment.
				const srcName =
					f.path === "package.json"
						? "package.json.seed"
						: f.path === "CLAUDE.md"
							? "CLAUDE.md.fragment"
							: f.path;
				let upstream = await readFile(join(packDir, "files", srcName), "utf8");
				// Fragment files ship without marker wrappers — add them so diffFile can extract the inner region.
				if (f.category === "hybrid" && f.format === "markdown" && srcName.endsWith(".fragment")) {
					upstream = `<!-- >>> claude-ds managed >>> -->\n${upstream}\n<!-- <<< claude-ds managed <<< -->`;
				} else if (
					f.category === "hybrid" &&
					f.format === "shell" &&
					srcName.endsWith(".fragment")
				) {
					upstream = `# >>> claude-ds managed >>>\n${upstream}\n# <<< claude-ds managed <<<`;
				}

				// #493: format the canonical bytes for showcase-chrome files that land
				// in the consumer's app_dir, BEFORE diffing/writing. Scoped to `app/`
				// pack files — the exact territory that broke Crewops' Biome lint.
				// Only claim a path as "formatted" when the formatter actually changed
				// the bytes, so a formatter that can't filter via stdin falls back to
				// the command's post-apply batch unchanged (no behaviour change).
				if (formatter && f.path.startsWith("app/")) {
					const formatted = formatContent(formatter, upstream, writePath, ctx.cwd);
					if (formatted !== upstream) {
						upstream = formatted;
						formattedPaths.push(writePath);
					}
				}

				// v1 gap: no prior-snapshot cache — use prev=null so managed files without a known
				// prior state are treated as "upstream wins" rather than false-abort on hand-edit detection.
				const prev: string | null = null;
				const current = (await ctx.exists(writePath)) ? await readFile(dest, "utf8") : null;

				// #505: enforcement.json is `seeded` — recreated from pack bytes when
				// missing. The pack defaults (radix / design-system) silently neuter
				// the v1.7.0 opt-in hooks on a base-ui / app-wide consumer. Derive the
				// flags from the tree before writing the fresh seed so the new hooks
				// land live and the consumer's hand-rolled validators become flaggable
				// duplicates (not dead-weight survivors). Only on first create — never
				// re-touch an existing consumer-owned file.
				if (f.path === ENFORCEMENT_PATH && current === null) {
					const manifestPaths = new Set(manifest.files.map((mf) => mf.path));
					const detected = await detectEnforcement(ctx.cwd, manifestPaths);
					upstream = applyDetectedEnforcement(upstream, detected);
				}

				const verdict = diffFile(
					{ category: f.category, format: f.format, owned_keys: f.owned_keys },
					{ prev, upstream, current },
				);

				// #18c: new files (current === null) display as "create:" even though verdict is "rewrite".
				const displayAction =
					verdict.action === "rewrite" && current === null ? "create" : verdict.action;
				const displayPath = writePath === f.path ? f.path : `${f.path} → ${writePath}`;
				decisions.push({ manifestPath: f.path, writePath, verdict, displayAction, displayPath });

				if (verdict.action === "skip") continue;
				if (verdict.action === "abort") {
					changes.push({ kind: "abort", path: writePath, reason: verdict.reason });
					continue;
				}
				const before = current === null ? null : Buffer.from(current, "utf8");
				const after =
					verdict.action === "rewrite-region"
						? Buffer.from(verdict.newContent, "utf8")
						: Buffer.from(verdict.newContent ?? upstream, "utf8");
				// #15: hook and script files must land as 0o755. The Runner honours the `mode`
				// hint via `chmod` after the atomic temp-file rename, replacing the post-write
				// loop sync used to do at the command boundary.
				// #507: only scripts under these dirs land executable. Data files that live
				// alongside them (verify-fixture.json, README.md) must stay 644 — they were
				// inheriting the 0o755 hook-script mode.
				const isDataFile = writePath.endsWith(".json") || writePath.endsWith(".md");
				const isExecutable =
					!isDataFile &&
					(writePath.startsWith(".claude/hooks/") || writePath.startsWith("scripts/"));
				const change: Change = isExecutable
					? { kind: "write", path: writePath, before, after, mode: "executable" }
					: { kind: "write", path: writePath, before, after };
				changes.push(change);
			}

			cached = { changes, decisions, formattedPaths };
			return { changes, outcome: { decisions, formattedPaths } };
		},
	};
}
