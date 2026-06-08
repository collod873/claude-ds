import { readFile, stat, readdir, chmod } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { info, err, printNextStep, setJsonMode } from "../lib/log.js";
import { detectLookalikes } from "../lib/lookalike.js";
import { detectPackageManager, runCmd } from "../lib/package-manager.js";
import { detectAppDir, detectClaudeMdCandidates, DEFAULT_CLAUDE_MD_TARGET } from "../lib/paths.js";
import { loadProject } from "../lib/project.js";
import { run } from "../lib/runner.js";
import { makeSyncPackFiles, type SyncPackFilesOutcome } from "../lib/ops/sync-pack-files.js";
import { migrateConfig } from "../lib/ops/migrate-config.js";
import { makeSeedClaudeMdMarkers } from "../lib/ops/seed-claude-md-markers.js";
import { patchTsconfigPathAlias } from "../lib/ops/patch-tsconfig-path-alias.js";
import { writeBootstrapClaudeDsConfig } from "../lib/bootstrap-config.js";
import { checkCleanTree } from "../lib/clean-tree.js";
import { createProgress } from "../lib/render/tty-layer.js";
import { emitHeadless, errorResult, HEADLESS_EXIT } from "../lib/headless.js";

const execFile = promisify(execFileCb);

// Read package.json for version (avoid JSON import assertions for broader compat).
async function getVersion(packageJsonPath: string): Promise<string> {
  const raw = await readFile(packageJsonPath, "utf8");
  return JSON.parse(raw).version as string;
}

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

/**
 * Patch the consumer's tsconfig.json to add a compilerOptions.paths entry
 * for "@/design-system/*" → ["../design-system/*"] so that src/app consumers
 * can import pack-installed files under design-system/ via the @/ alias.
 *
 * Without this, @/* resolves to ./src/* but design-system/ lives at repo root,
 * causing build errors on every /design route. (#52)
 *
 * Only runs when the consumer uses a src/app layout. Idempotent. The actual
 * byte mutation flows through the Runner via the `patchTsconfigPathAlias` Op
 * (#221 capstone); this wrapper handles the unparseable-tsconfig log and the
 * "alias patched" success log.
 */
async function patchTsconfigForSrcApp(cwd: string): Promise<void> {
  const ctx = await loadProject(cwd);
  const { op, unparseable } = patchTsconfigPathAlias("@/design-system/*", "../design-system/*");
  const report = await run(ctx, [op], "apply");
  if (unparseable()) {
    info("warning: could not parse tsconfig.json (comments?); skipping @/design-system/* path injection. Add manually: compilerOptions.paths[\"@/design-system/*\"] = [\"../design-system/*\"]");
    return;
  }
  if (report.failed) {
    err(`patch tsconfig failed: ${report.failed.error}`);
    return;
  }
  if (report.applied.some(c => c.kind === "write" && c.path === "tsconfig.json")) {
    info("patched tsconfig.json: added @/design-system/* path alias for src/app layout (#52)");
  }
}

export async function adoptCmd(opts: { pack?: string; yes?: boolean; ignore?: string; dryRun?: boolean; allowDirty?: boolean; json?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.json) setJsonMode(true);

  // Clean-tree guard (PRD #325 / sub-issue #328). Adopt writes the initial
  // .claude-ds.json and a sheaf of pack-managed files; mixing those with the
  // consumer's uncommitted work loses the git-history-is-the-undo property.
  // --dry-run is non-destructive so it bypasses; --allow-dirty is the
  // authorized override.
  if (!opts.dryRun) {
    const guard = checkCleanTree({ command: "adopt", cwd, allowDirty: opts.allowDirty });
    if (!guard.ok) {
      err(guard.message);
      if (opts.json) emitHeadless(errorResult("adopt", guard.message));
      process.exit(2);
    }
  }

  if (await exists(join(cwd, ".claude-ds.json"))) {
    const msg = ".claude-ds.json already exists — did you mean `claude-ds sync`?";
    err(msg);
    if (opts.json) emitHeadless(errorResult("adopt", msg));
    process.exit(2);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");

  // Auto-detect pack if not specified: list packs/ dir and default when only one exists.
  let pack = opts.pack;
  if (!pack) {
    const packsDir = join(repoRoot, "packs");
    let available: string[] = [];
    try {
      const entries = await readdir(packsDir, { withFileTypes: true });
      available = entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch { available = []; }
    if (available.length === 1) {
      pack = available[0];
    } else if (available.length === 0) {
      const m = "--pack required: no packs found in packs/";
      err(m);
      if (opts.json) emitHeadless(errorResult("adopt", m));
      process.exit(2);
    } else {
      const m = `--pack required: valid packs are: ${available.join(", ")}`;
      err(m);
      if (opts.json) emitHeadless(errorResult("adopt", m));
      process.exit(2);
    }
  }

  const packDir = join(repoRoot, "packs", pack);
  const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));

  // Parse --ignore flag globs (comma-separated).
  // Merge order: pack defaults < --ignore flag (flag extends, not replaces).
  const flagGlobs = opts.ignore ? opts.ignore.split(",").map(g => g.trim()).filter(Boolean) : [];
  const ignoreGlobs = [...manifest.lookalike_ignore, ...flagGlobs];

  // ---- Interactive phase (precedes loadProject) ---------------------------
  // Per CONTEXT.md "Working rules": prompts live in commands, not Operations.
  // Resolve all user decisions (lookalike gate, app_dir, claude_md_target) up
  // front, then write the initial config + boot a ProjectContext + delegate
  // file writes to the Runner.

  // Precondition gate runs BEFORE the confirmation prompt — fail fast on lookalikes.
  // ignoreGlobs lets users suppress false positives from the heuristic.
  const findings = await detectLookalikes(cwd, manifest.canonical_paths, ignoreGlobs);
  const blockers = findings.filter(f => !f.present && f.lookalike !== null);
  if (blockers.length > 0) {
    const lines: string[] = [
      "adopt refused: lookalike files detected — rename to canonical names first.",
      "",
      "The following project files use different vocabulary than the canonical names.",
      "Rename them before running adopt (use `doctor` to see the full report):",
      "",
    ];
    for (const b of blockers) {
      lines.push(`  ${b.lookalike} → ${b.canonical}`);
    }
    lines.push("");
    lines.push("No files were modified.");
    lines.push("If these matches are false positives, re-run with --ignore '<glob>,<glob>'");
    process.stderr.write(lines.join("\n") + "\n");
    if (opts.json) {
      emitHeadless(errorResult("adopt", "lookalikes detected — rename to canonical names first", {
        lookalikes: blockers.map(b => ({ lookalike: b.lookalike, canonical: b.canonical })),
      }));
    }
    process.exit(2);
  }

  // #47: detect Next.js app router root. src/app/ is officially supported; manifest stays
  // canonical (uses "app/") and the CLI rewrites the prefix at every I/O boundary.
  const appDir = await detectAppDir(cwd);

  // #34: pick where the managed pointer block goes. NEVER auto-create root CLAUDE.md.
  // Priority when --yes (or only one candidate exists):
  //   1. existing .claude/CLAUDE.md   (preferred — Claude Code auto-loads, no root pollution)
  //   2. existing ./CLAUDE.md         (user-authored; inject at bottom)
  //   3. existing docs/CLAUDE.md
  //   4. fall back to default (.claude/CLAUDE.md, create stub)
  const candidates = await detectClaudeMdCandidates(cwd);
  let claudeMdTarget: string;
  if (candidates.length === 0) {
    claudeMdTarget = DEFAULT_CLAUDE_MD_TARGET;
  } else if (candidates.length === 1) {
    claudeMdTarget = candidates[0];
  } else {
    // Prefer .claude/ over root over docs (matches the "least intrusive" policy in #34).
    claudeMdTarget = candidates.find(c => c === ".claude/CLAUDE.md")
      ?? candidates.find(c => c === "CLAUDE.md")
      ?? candidates[0];
  }

  if (opts.dryRun) {
    info(`[dry-run] would adopt pack=${pack}, mode=warn, app_dir=${appDir}, claude_md_target=${claudeMdTarget}`);
    info("[dry-run] no files modified");
    if (opts.json) {
      emitHeadless({
        command: "adopt",
        ok: true,
        verdict: "dry-run",
        exitCode: HEADLESS_EXIT.OK,
        actions: { dryRun: true, pack, appDir, claudeMdTarget },
        remaining: {},
      });
    }
    return;
  }

  // Live progress UI for adopt's phased setup (PRD #325 / sub-issue #332).
  // No-op on non-TTY so the agent's stdout output is byte-identical to today.
  const progress = createProgress();
  try {

  progress.start("preparing project");
  // Run user's pre-existing build-manifest.ts (if any) BEFORE pack files overwrite it.
  // This allows a failing script to be detected as non-fatal before the pack's version lands.
  {
    const buildScriptPath = join(cwd, "scripts", "build-manifest.ts");
    const manifestPath = join(cwd, "design-system", "manifest.json");
    if (await exists(buildScriptPath) && !(await exists(manifestPath))) {
      try {
        await execFile("node", ["--experimental-strip-types", buildScriptPath], {
          cwd,
          timeout: 30_000,
        });
        info("bootstrapped design-system/manifest.json");
      } catch (e: unknown) {
        const exitCode = (e as { code?: number }).code ?? "?";
        info(`warning: build-manifest failed (exit ${exitCode}), manifest.json not created. Run manually: node --experimental-strip-types scripts/build-manifest.ts`);
      }
    }
  }
  progress.succeed("preparing project");

  // ---- Init boundary: write the initial .claude-ds.json so loadProject can boot ----
  // This is the documented exception to the "all writes go through the Runner" rule —
  // adopt is the only command that creates the config file. Once written, every
  // subsequent file mutation in this command flows through the Runner chokepoint.
  const version = await getVersion(join(repoRoot, "package.json"));
  const cfg: Record<string, unknown> = {
    packVersion: `v${version}`,
    pack,
    mode: "warn",
    enforce_threshold: 10,
    removed: [],
    app_dir: appDir,
    claude_md_target: claudeMdTarget,
    // #382: land at the verification chain's fixed point on a fresh adopt. The
    // meta-kind-hard@v0.9.0 migration's end-state is meta_kind_strict: true;
    // without it the repair probe in deriveProjectState plans a flip on a
    // just-adopted tree (and the front door shows a phantom "1 step: repair").
    // Safe to seed eagerly: the pack ships no files under
    // design-system/atoms|composites|patterns, so DRIFT-META-KIND-MISSING has
    // nothing to flag post-adopt. If the consumer already has files in those
    // tier folders without meta.kind, audit --fix / heal backfill them — the
    // same path the v0.9.0 migration would force after upgrade anyway.
    meta_kind_strict: true,
  };
  if (flagGlobs.length > 0) cfg.lookalike_ignore = flagGlobs;
  await writeBootstrapClaudeDsConfig(cwd, cfg);

  // ---- Boot ProjectContext and route file writes through the Runner ----
  // First install becomes the special case where diffFile sees `current = null`:
  //   - managed/hybrid/seeded files with no on-disk counterpart → verdict "rewrite, missing on disk — recreating"
  //   - pre-existing managed files → verdict "rewrite, upstream changed" (or "skip, in sync" if byte-identical)
  //   - pre-existing hybrid files → marker/JSON-key merge via diffFile, same as sync
  // This is why we no longer need adopt-specific write logic — diffFile + Runner cover it.
  //
  // NOTE: backfillCompanions Op (#81) will compose here once it exists. Adopt does not
  // currently do companion stub backfill, so no inline placeholder is needed.
  //
  // #85: apply migrateConfig before the main Op pipeline. Adopt just wrote a fresh
  // current-shape config above, so this is structurally a no-op here — but wiring
  // it in for symmetry with sync/reconform protects against the case where adopt
  // is re-run against a pre-v0.6 config (and keeps the pattern uniform across
  // commands so future readers don't wonder why adopt is the odd one out).
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
      if (opts.json) emitHeadless(errorResult("adopt", m));
      process.exit(2);
    }
  }

  const ctx = await loadProject(cwd);
  // #86: seed markers before syncPackFiles so diffFile always sees a well-formed
  // hybrid+markdown file. Without this, a markerless pre-existing CLAUDE.md target
  // causes diffFile → extractMarkerInner to throw → abort verdict → managed block
  // never lands. seedClaudeMdMarkers is idempotent (no-ops if markers exist).
  const seedOp = makeSeedClaudeMdMarkers();
  const op = makeSyncPackFiles();
  progress.start("installing pack files");
  const report = await run(ctx, [seedOp, op], "apply");

  if (report.failed) {
    progress.fail(`installing pack files — ${report.failed.change.kind}`);
    const m = `adopt failed at ${report.failed.change.kind}: ${report.failed.error}`;
    err(m);
    if (opts.json) emitHeadless(errorResult("adopt", m));
    process.exit(2);
  }
  progress.succeed("installing pack files");

  // Sync's per-file decisions land in its OpReport entry. Looked up by name
  // rather than index so the overwrite-reporting block below stays correct if
  // the seed/sync op pair is later reordered or extended.
  const syncOutcome = report.ops.find(o => o.name === "sync-pack-files")?.outcome as
    | SyncPackFilesOutcome
    | undefined;
  const syncDecisions = syncOutcome?.decisions ?? [];

  // ---- Post-write housekeeping ------------------------------------------
  // #15: hook and script files must be executable. Runner writes bytes only; chmod is
  // a post-write concern that stays at the command boundary (mirrors sync.ts).
  for (const c of report.applied) {
    if (c.kind !== "write") continue;
    if (c.path.startsWith(".claude/hooks/") || c.path.startsWith("scripts/")) {
      await chmod(join(cwd, c.path), 0o755);
    }
  }

  // Overwrite reporting — reconstruct from sync's outcome decisions + applied
  // Changes so the existing user-facing "Overwrote N managed file(s)" preview
  // format is preserved. A write that had a non-null `before` is an overwrite
  // of pre-existing user content.
  interface OverwriteRecord { path: string; prevSize: number; newSize: number; category: "managed" | "hybrid"; }
  const overwrites: OverwriteRecord[] = [];
  const decisionByWritePath = new Map(syncDecisions.map(d => [d.writePath, d]));
  for (const c of report.applied) {
    if (c.kind !== "write" || c.before === null) continue;
    if (c.before.equals(c.after)) continue; // no-op write (defensive; diffFile would have skipped)
    const d = decisionByWritePath.get(c.path);
    if (!d) continue;
    const entry = manifest.files.find(f => f.path === d.manifestPath);
    if (!entry) continue;
    if (entry.category !== "managed" && entry.category !== "hybrid") continue;
    overwrites.push({
      path: d.manifestPath,
      prevSize: c.before.length,
      newSize: c.after.length,
      category: entry.category,
    });
  }

  if (overwrites.length > 0) {
    const managedOvr = overwrites.filter(o => o.category === "managed");
    const hybridOvr = overwrites.filter(o => o.category === "hybrid");
    const lines: string[] = [];
    if (managedOvr.length > 0) {
      lines.push(`Overwrote ${managedOvr.length} managed file(s) (pack-owned, previous content replaced):`);
      for (const o of managedOvr) {
        lines.push(`  ${o.path}  (was ${o.prevSize} bytes, now ${o.newSize} bytes)`);
      }
      lines.push("Project-specific customizations to these files have been replaced.");
    }
    if (hybridOvr.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(`Updated ${hybridOvr.length} hybrid file(s) (pack-owned regions updated; user-owned content preserved):`);
      for (const o of hybridOvr) {
        lines.push(`  ${o.path}  (was ${o.prevSize} bytes, now ${o.newSize} bytes)`);
      }
      lines.push("Pack-owned regions updated; user-owned content preserved.");
    }
    lines.push("To diff before adopt, run: claude-ds doctor --pack <name>");
    // Issue #408: under --json the JSON document must be the entirety of
    // stdout. The overwrite preview rides on `actions.overwrites` instead.
    if (!opts.json) process.stdout.write(lines.join("\n") + "\n");
  }

  progress.start("finishing setup");
  // #52: src/app consumers have @/* → ./src/* in their tsconfig, so
  // @/design-system/* resolves to ./src/design-system/* which doesn't exist
  // (design-system/ always lives at repo root). Inject a path override that
  // maps @/design-system/* → ../design-system/* (one level above src/).
  // This makes both manifest.json and manifest.generated.ts imports work
  // without patching the pack templates per-layout.
  if (appDir === "src/app") {
    await patchTsconfigForSrcApp(cwd);
  }

  // Post-pack-write build-manifest run: now that scripts/build-manifest.ts has been
  // installed (managed file from the pack), run it if no manifest exists yet. The
  // pre-write run above handled the case where the user had a pre-existing script;
  // this handles the fresh-install case.
  const buildScriptPath = join(cwd, "scripts", "build-manifest.ts");
  const manifestPath = join(cwd, "design-system", "manifest.json");
  if (await exists(buildScriptPath) && !(await exists(manifestPath))) {
    try {
      await execFile("node", ["--experimental-strip-types", buildScriptPath], {
        cwd,
        timeout: 30_000,
      });
      info("bootstrapped design-system/manifest.json");
    } catch (e: unknown) {
      const exitCode = (e as { code?: number }).code ?? "?";
      info(`warning: build-manifest failed (exit ${exitCode}), manifest.json not created. Run manually: node --experimental-strip-types scripts/build-manifest.ts`);
    }
  }
  progress.succeed("finishing setup");

  const pm = await detectPackageManager(cwd);
  // #454: NOT a "Next:" line. adopt already bootstraps the manifest above, so
  // re-running `ds:build-manifest` advances no state — a `Next:` breadcrumb the
  // liveness gate (ADR-0013) rightly grades as a dead end. Reworded as a plain
  // "regenerate any time with" note; the real next action is the printNextStep
  // breadcrumb below.
  info(`adopted claude-ds (${pack}, mode=warn). Run 'enforce' when ready. Detected package manager: ${pm}. Regenerate the manifest any time with ${runCmd(pm, "ds:build-manifest")}.`);
  info(`CI scripts installed. Run: ${runCmd(pm, "ci:hook-contract")} and ${runCmd(pm, "ci:consistency")}`);
  info(`A starter GitHub Actions workflow was seeded at .github/workflows/claude-ds-governance.yml (delete if not on GH Actions). See docs/ci-wiring.md for details.`);
  printNextStep("adopt", {});

  if (opts.json) {
    // Pack the headless contract: what got installed, what overwrote
    // user content, what the operator still has to do (build-manifest).
    const writes = report.applied.filter(c => c.kind === "write").length;
    emitHeadless({
      command: "adopt",
      ok: true,
      verdict: "adopted",
      exitCode: HEADLESS_EXIT.OK,
      actions: {
        pack,
        appDir,
        claudeMdTarget,
        filesWritten: writes,
        overwrites: overwrites.map(o => ({ path: o.path, category: o.category })),
      },
      remaining: { packageManager: pm },
    });
  }
  } finally {
    progress.stop();
  }
}
