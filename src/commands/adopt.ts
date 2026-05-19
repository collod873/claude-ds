import { readFile, writeFile, mkdir, stat, readdir, chmod } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { mergeJsonKeys } from "../lib/json-merge.js";
import { info, err, confirm } from "../lib/log.js";
import { detectLookalikes } from "../lib/lookalike.js";
import { detectPackageManager, runCmd } from "../lib/package-manager.js";
import { detectAppDir, detectClaudeMdCandidates, DEFAULT_CLAUDE_MD_TARGET, resolveManifestPath } from "../lib/paths.js";

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

// Paths under these prefixes require the executable bit (relative to project root).
function needsExecBit(relPath: string): boolean {
  return relPath.startsWith(".claude/hooks/") || relPath.startsWith("scripts/");
}

async function writeExecutable(dest: string, content: string, relPath: string): Promise<void> {
  await writeFile(dest, content, "utf8");
  if (needsExecBit(relPath)) await chmod(dest, 0o755);
}

interface OverwriteRecord { path: string; prevSize: number; newSize: number; category: "managed" | "hybrid"; }

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

  const overwrites: OverwriteRecord[] = [];

  for (const f of manifest.files) {
    if (f.category === "generated") continue;
    // #34: CLAUDE.md is no longer written through the normal manifest loop — it goes
    // through a dedicated injection path (below) so it lands at claude_md_target, never root.
    if (f.path === "CLAUDE.md") continue;
    const srcName = f.path === "package.json" ? "package.json.seed" : f.path;
    // #47: rewrite app/... paths through the detected app_dir (manifest stays canonical).
    const writePath = resolveManifestPath(f.path, appDir);
    const dest = resolve(cwd, writePath);
    const cwdResolved = resolve(cwd);
    if (dest !== cwdResolved && !dest.startsWith(cwdResolved + "/")) {
      err(`manifest path escapes project root: ${f.path}`);
      process.exit(2);
    }
    if (f.category === "seeded" && await exists(dest)) continue;
    const content = await readFile(join(packDir, "files", srcName), "utf8");
    await mkdir(dirname(dest), { recursive: true });
    if (f.category === "hybrid" && f.format === "markdown" && await exists(dest)) {
      const cur = await readFile(dest, "utf8");
      const merged = `${cur}\n<!-- >>> claude-ds managed >>> -->\n${content}\n<!-- <<< claude-ds managed <<< -->\n`;
      // Record overwrite only when merged result differs from current on-disk content.
      if (merged !== cur) {
        overwrites.push({ path: f.path, prevSize: Buffer.byteLength(cur, "utf8"), newSize: Buffer.byteLength(merged, "utf8"), category: "hybrid" });
      }
      await writeExecutable(dest, merged, f.path);
    } else if (f.category === "hybrid" && f.format === "markdown") {
      await writeExecutable(dest, `# Project\n<!-- >>> claude-ds managed >>> -->\n${content}\n<!-- <<< claude-ds managed <<< -->\n`, f.path);
    } else if (f.category === "hybrid" && f.format === "json") {
      if (await exists(dest)) {
        const current = await readFile(dest, "utf8");
        // Detect existing indentation: find first indented line, check if it starts with a tab.
        const firstIndented = current.split("\n").find(l => l.startsWith(" ") || l.startsWith("\t"));
        const indent = firstIndented && firstIndented.startsWith("\t") ? "\t" : 2;
        const merged = mergeJsonKeys(content, current, f.owned_keys ?? ["hooks"], indent);
        if (merged !== current) {
          overwrites.push({ path: f.path, prevSize: Buffer.byteLength(current, "utf8"), newSize: Buffer.byteLength(merged, "utf8"), category: "hybrid" });
        }
        await writeExecutable(dest, merged, f.path);
      } else {
        await writeExecutable(dest, content, f.path);
      }
    } else {
      // managed category: check for overwrite before writing.
      if (f.category === "managed" && await exists(dest)) {
        const current = await readFile(dest, "utf8");
        if (current !== content) {
          overwrites.push({ path: f.path, prevSize: Buffer.byteLength(current, "utf8"), newSize: Buffer.byteLength(content, "utf8"), category: "managed" });
        }
      }
      await writeExecutable(dest, content, f.path);
    }
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

  // #34: inject the managed pointer block into claudeMdTarget. Never write root unless that's the target.
  const claudeMdEntry = manifest.files.find(f => f.path === "CLAUDE.md");
  if (claudeMdEntry) {
    const fragment = await readFile(join(packDir, "files", "CLAUDE.md.fragment"), "utf8");
    const block = `<!-- >>> claude-ds managed >>> -->\n${fragment}\n<!-- <<< claude-ds managed <<< -->\n`;
    const targetAbs = resolve(cwd, claudeMdTarget);
    await mkdir(dirname(targetAbs), { recursive: true });
    if (await exists(targetAbs)) {
      const cur = await readFile(targetAbs, "utf8");
      // If the block is already present (idempotent re-adopt), skip rewriting.
      if (!cur.includes("<!-- >>> claude-ds managed >>> -->")) {
        const sep = cur.endsWith("\n") ? "" : "\n";
        await writeFile(targetAbs, `${cur}${sep}\n## claude-ds\n${block}`, "utf8");
      }
    } else {
      // Create a minimal stub at the chosen target. Header makes it clear who owns the file.
      await writeFile(targetAbs, `# Project\n\n## claude-ds\n${block}`, "utf8");
    }
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

  const version = await getVersion(join(repoRoot, "package.json"));
  const cfg: Record<string, unknown> = { version: `v${version}`, pack, mode: "warn", enforce_threshold: 10, removed: [] };
  if (flagGlobs.length > 0) cfg.lookalike_ignore = flagGlobs;
  // #47/#34: persist detected layout so sync/audit/reconform use the same locations.
  cfg.app_dir = appDir;
  cfg.claude_md_target = claudeMdTarget;
  await writeFile(join(cwd, ".claude-ds.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
  const pm = await detectPackageManager(cwd);
  info(`adopted claude-ds (${pack}, mode=warn). Run 'enforce' when ready. Detected package manager: ${pm}. Next: ${runCmd(pm, "ds:build-manifest")}`);
}
