import { readFile, writeFile, stat, readdir, chmod } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { info, err, confirm } from "../lib/log.js";
import { detectLookalikes } from "../lib/lookalike.js";
import { detectPackageManager, runCmd } from "../lib/package-manager.js";
import { detectAppDir, detectClaudeMdCandidates, DEFAULT_CLAUDE_MD_TARGET } from "../lib/paths.js";
import { loadProject } from "../lib/project.js";
import { run } from "../lib/runner.js";
import { makeSyncPackFiles } from "../lib/ops/sync-pack-files.js";
import { migrateConfig } from "../lib/ops/migrate-config.js";

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
 * Only runs when the consumer uses a src/app layout. Idempotent.
 *
 * NOTE: this remains a direct write (not routed through the Runner) because
 * tsconfig.json is not a pack-owned file — it's a consumer config the CLI
 * surgically patches once at adopt time. It is not in the manifest, so
 * syncPackFiles cannot plan a Change for it.
 */
async function patchTsconfigForSrcApp(cwd: string): Promise<void> {
  const tsconfigPath = join(cwd, "tsconfig.json");
  if (!await exists(tsconfigPath)) return; // no tsconfig to patch

  let raw: string;
  try {
    raw = await readFile(tsconfigPath, "utf8");
  } catch {
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // tsconfig has comments or is malformed — skip silently to avoid breaking it
    info("warning: could not parse tsconfig.json (comments?); skipping @/design-system/* path injection. Add manually: compilerOptions.paths[\"@/design-system/*\"] = [\"../design-system/*\"]");
    return;
  }

  const compilerOptions = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
  const paths = (compilerOptions.paths ?? {}) as Record<string, string[]>;

  // Already patched — idempotent.
  if (paths["@/design-system/*"]) return;

  paths["@/design-system/*"] = ["../design-system/*"];
  compilerOptions.paths = paths;
  parsed.compilerOptions = compilerOptions;

  const firstIndented = raw.split("\n").find(l => l.startsWith(" ") || l.startsWith("\t"));
  const indent = firstIndented && firstIndented.startsWith("\t") ? "\t" : 2;
  await writeFile(tsconfigPath, JSON.stringify(parsed, null, indent) + "\n", "utf8");
  info("patched tsconfig.json: added @/design-system/* path alias for src/app layout (#52)");
}

export async function adoptCmd(opts: { pack?: string; yes?: boolean; ignore?: string; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  if (await exists(join(cwd, ".claude-ds.json"))) { err(".claude-ds.json already exists — did you mean `claude-ds sync`?"); process.exit(2); }

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
      err("--pack required: no packs found in packs/"); process.exit(2);
    } else {
      err(`--pack required: valid packs are: ${available.join(", ")}`); process.exit(2);
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
  } else if (opts.yes) {
    // Prefer .claude/ over root over docs (matches the "least intrusive" policy in #34).
    claudeMdTarget = candidates.find(c => c === ".claude/CLAUDE.md")
      ?? candidates.find(c => c === "CLAUDE.md")
      ?? candidates[0];
  } else {
    process.stdout.write(`\nMultiple CLAUDE.md files found — choose where the managed pointer block lives:\n`);
    candidates.forEach((c, i) => process.stdout.write(`  ${i + 1}. ${c}\n`));
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question(`Pick [1-${candidates.length}]: `)).trim();
    rl.close();
    const idx = Number.parseInt(ans, 10) - 1;
    claudeMdTarget = (idx >= 0 && idx < candidates.length) ? candidates[idx] : candidates[0];
  }

  if (!opts.yes && !(await confirm(`Adopt claude-ds (pack=${pack}, WARN mode) here?`))) { info("aborted"); return; }

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

  // ---- Init boundary: write the initial .claude-ds.json so loadProject can boot ----
  // This is the documented exception to the "all writes go through the Runner" rule —
  // adopt is the only command that creates the config file. Once written, every
  // subsequent file mutation in this command flows through the Runner chokepoint.
  const version = await getVersion(join(repoRoot, "package.json"));
  const cfg: Record<string, unknown> = {
    version: `v${version}`,
    pack,
    mode: "warn",
    enforce_threshold: 10,
    removed: [],
    app_dir: appDir,
    claude_md_target: claudeMdTarget,
  };
  if (flagGlobs.length > 0) cfg.lookalike_ignore = flagGlobs;
  await writeFile(join(cwd, ".claude-ds.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");

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
      err(`migrate-config failed: ${migrationReport.failed.error}`);
      process.exit(2);
    }
  }

  const ctx = await loadProject(cwd);
  const op = makeSyncPackFiles();
  const report = await run(ctx, [op], "apply");

  if (report.failed) {
    err(`adopt failed at ${report.failed.change.kind}: ${report.failed.error}`);
    process.exit(2);
  }

  // CLAUDE.md first-install marker injection — kept inline, NOT yet routed through Runner.
  //
  // FINDING: syncPackFiles uses diffFile for hybrid-markdown, which calls
  // extractMarkerInner() on `current`. If the consumer's CLAUDE.md target pre-exists
  // WITHOUT the managed marker pair (common at adopt time — they wrote their own
  // CLAUDE.md before adopting), diffFile returns `abort` and the Runner correctly
  // no-ops the write. Legacy adopt's behavior in that case was to APPEND a
  // `## claude-ds\n<markers>` block to the bottom of that markerless file —
  // semantically different from "merge inside markers" (the sync verdict).
  //
  // Routing this cleanly needs either a dedicated Op (e.g. `seedClaudeMdMarkers`) or
  // a diffFile extension that handles "no markers yet → append a fresh marker block."
  // For now, preserve legacy behavior inline so the marker block lands; subsequent
  // `sync` runs will see a well-formed hybrid file and route through diffFile normally.
  //
  // The `current === null` case (CLAUDE.md target does not exist) is already handled
  // by syncPackFiles + Runner — diffFile returns `rewrite` and writes the
  // marker-wrapped fragment.
  const claudeMdEntry = manifest.files.find(f => f.path === "CLAUDE.md");
  if (claudeMdEntry) {
    const targetAbs = resolve(cwd, claudeMdTarget);
    if (await exists(targetAbs)) {
      const cur = await readFile(targetAbs, "utf8");
      if (!cur.includes("<!-- >>> claude-ds managed >>> -->")) {
        const fragment = await readFile(join(packDir, "files", "CLAUDE.md.fragment"), "utf8");
        const block = `<!-- >>> claude-ds managed >>> -->\n${fragment}\n<!-- <<< claude-ds managed <<< -->\n`;
        const sep = cur.endsWith("\n") ? "" : "\n";
        await writeFile(targetAbs, `${cur}${sep}\n## claude-ds\n${block}`, "utf8");
      }
    }
  }

  // ---- Post-write housekeeping ------------------------------------------
  // #15: hook and script files must be executable. Runner writes bytes only; chmod is
  // a post-write concern that stays at the command boundary (mirrors sync.ts).
  for (const c of report.applied) {
    if (c.kind !== "write") continue;
    if (c.path.startsWith(".claude/hooks/") || c.path.startsWith("scripts/")) {
      await chmod(join(cwd, c.path), 0o755);
    }
  }

  // Overwrite reporting — reconstruct from op.decisions + applied Changes so the
  // existing user-facing "Overwrote N managed file(s)" preview format is preserved.
  // A write that had a non-null `before` is an overwrite of pre-existing user content.
  interface OverwriteRecord { path: string; prevSize: number; newSize: number; category: "managed" | "hybrid"; }
  const overwrites: OverwriteRecord[] = [];
  const decisionByWritePath = new Map(op.decisions.map(d => [d.writePath, d]));
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
    process.stdout.write(lines.join("\n") + "\n");
  }

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

  const pm = await detectPackageManager(cwd);
  info(`adopted claude-ds (${pack}, mode=warn). Run 'enforce' when ready. Detected package manager: ${pm}. Next: ${runCmd(pm, "ds:build-manifest")}`);
  info(`CI scripts installed. Run: ${runCmd(pm, "ci:hook-contract")} and ${runCmd(pm, "ci:consistency")}`);
  info(`A starter GitHub Actions workflow was seeded at .github/workflows/claude-ds-governance.yml (delete if not on GH Actions). See docs/ci-wiring.md for details.`);
}
