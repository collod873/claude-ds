import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DeprecatedPath } from "../lib/manifest.js";
import { loadProject } from "../lib/project.js";
import { info, err, confirm } from "../lib/log.js";
import { createInterface } from "node:readline/promises";
import { scanRootDupes, RootDupeFinding } from "../lib/root-dupes.js";
import { run, type Operation } from "../lib/runner.js";
import { makeDeleteFiles, makeMergeRootToCanonical, makePruneDanglingHooks } from "../lib/ops/reconcile-mutations.js";
import { extractScriptPath } from "../lib/json-merge.js";
import { readFile } from "node:fs/promises";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

export interface ReconcileFinding {
  kind: "deprecated" | "collision" | "dangling-hook";
  path: string;
  detail: string;
}

/**
 * Scan a project tree for files that were seeded by prior pack versions
 * but are no longer part of the current manifest.
 *
 * Returns findings without mutating the filesystem (pure scan).
 */
export async function scanDeprecated(
  cwd: string,
  deprecatedPaths: DeprecatedPath[]
): Promise<ReconcileFinding[]> {
  const findings: ReconcileFinding[] = [];
  for (const d of deprecatedPaths) {
    const full = join(cwd, d.path);
    if (await exists(full)) {
      findings.push({
        kind: "deprecated",
        path: d.path,
        detail: `deprecated since ${d.since_version}: ${d.reason}`,
      });
    }
  }
  return findings;
}

/**
 * Detect CLAUDE.md collision: pack writes root CLAUDE.md but project already has
 * .claude/CLAUDE.md. Both end up loaded by Claude Code — one is orphaned.
 */
export async function scanClaudeMdCollision(cwd: string): Promise<ReconcileFinding[]> {
  const findings: ReconcileFinding[] = [];
  const rootClaude = join(cwd, "CLAUDE.md");
  const dotClaude = join(cwd, ".claude", "CLAUDE.md");
  if ((await exists(rootClaude)) && (await exists(dotClaude))) {
    findings.push({
      kind: "collision",
      path: "CLAUDE.md",
      detail: "both CLAUDE.md and .claude/CLAUDE.md exist — one is a stale orphan from earlier adopt",
    });
  }
  return findings;
}


/**
 * Scan `.claude/settings.json` for pack-owned hook entries whose referenced
 * script does not exist on disk or is about to be deleted (in deprecatedPaths).
 */
export async function scanDanglingHooks(
  cwd: string,
  deprecatedPaths: DeprecatedPath[],
): Promise<ReconcileFinding[]> {
  const settingsPath = join(cwd, ".claude", "settings.json");
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch {
    return [];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return [];

  const deprecatedSet = new Set(deprecatedPaths.map((d) => d.path));
  const findings: ReconcileFinding[] = [];

  for (const blocks of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks as Array<{ hooks?: Array<{ command?: string }> }>) {
      if (!block?.hooks) continue;
      for (const entry of block.hooks) {
        if (typeof entry.command !== "string") continue;
        if (!entry.command.startsWith(".claude/hooks/")) continue;
        const scriptPath = extractScriptPath(entry.command);
        const scriptExists = await exists(join(cwd, scriptPath));
        const isDeprecated = deprecatedSet.has(scriptPath);
        if (!scriptExists || isDeprecated) {
          const detail = !scriptExists
            ? "hook references non-existent script"
            : "hook references deprecated script (will be deleted)";
          findings.push({ kind: "dangling-hook", path: scriptPath, detail });
        }
      }
    }
  }

  // Deduplicate — same script may appear in multiple hooks
  const seen = new Set<string>();
  return findings.filter((f) => {
    if (seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });
}

export interface ReconcileResult {
  deleted: number;
  pruned: number;
  skipped: number;
  collisionWarnings: string[];
}

/**
 * Core reconcile logic: scan and apply reconcile actions.
 * Used by both `reconcile` command and `audit --fix`.
 *
 * `force`: auto-delete without prompting (equivalent to --force).
 * When not force and not TTY, non-interactive actions (orphan deletion, hook pruning)
 * still auto-apply, but interactive decisions (collisions, content-differs dupes)
 * skip with warnings.
 */
export async function runReconcileActions(
  ctx: import("../lib/project.js").ProjectContext,
  opts: { force?: boolean; dryRun?: boolean },
): Promise<ReconcileResult> {
  const cwd = ctx.cwd;
  const cfg = ctx.cfg;
  const manifest = ctx.manifest;
  const force = opts.force ?? false;
  const dryRun = opts.dryRun ?? false;

  const result: ReconcileResult = { deleted: 0, pruned: 0, skipped: 0, collisionWarnings: [] };

  // ── Scan ───────────────────────────────────────────────────────────────────
  const deprecatedFindings = await scanDeprecated(cwd, manifest.deprecated_paths);
  const collisionFindings = cfg.claude_md_target === "CLAUDE.md"
    ? await scanClaudeMdCollision(cwd)
    : [];
  const rootDupeFindings = await scanRootDupes(cwd, manifest.deprecated_paths);
  const danglingHookFindings = await scanDanglingHooks(cwd, manifest.deprecated_paths);
  const allFindings = [...deprecatedFindings, ...collisionFindings, ...danglingHookFindings];

  if (allFindings.length === 0 && rootDupeFindings.length === 0) {
    return result;
  }

  if (dryRun) {
    return result;
  }

  const isTTY = Boolean(process.stdin.isTTY);
  const rootDupeMap = new Map(rootDupeFindings.map(f => [f.rootPath, f]));

  // ── Gather decisions (no I/O yet) ─────────────────────────────────────────
  const pathsToDelete: string[] = [];
  const mergeRequests: Array<{ root: string; canonical: string }> = [];

  // ── Remediate root dupes (content-differs path) ───────────────────────────
  for (const f of rootDupeFindings) {
    if (!f.contentDiffers) continue;
    if (!isTTY && !force) {
      info(`warning: ${f.rootPath} content differs from ${f.canonicalPath} — run \`reconcile\` interactively to merge, or pass --force to delete root`);
      result.skipped++;
      continue;
    }
    if (force) {
      pathsToDelete.push(f.rootPath);
      continue;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(`\nRoot dupe with different content: ${f.rootPath}\n`);
    process.stdout.write(`  Canonical: ${f.canonicalPath}\n`);
    process.stdout.write(`  (a) merge root → canonical (overwrites canonical with root content), then delete root\n`);
    process.stdout.write(`  (b) keep canonical as-is, delete root\n`);
    process.stdout.write(`  (c) skip — resolve manually\n`);
    const ans = (await rl.question(`Choose [a/b/c]: `)).trim().toLowerCase();
    rl.close();
    if (ans === "a") {
      mergeRequests.push({ root: f.rootPath, canonical: f.canonicalPath });
    } else if (ans === "b") {
      pathsToDelete.push(f.rootPath);
    } else {
      info(`skipped: ${f.rootPath} — resolve manually`);
      result.skipped++;
    }
  }

  // ── Remediate deprecated orphans ──────────────────────────────────────────
  const collisionList = allFindings.filter(f => f.kind === "collision");
  const deprecatedList = allFindings.filter(f => f.kind === "deprecated");

  const toDelete = deprecatedList;
  for (const f of toDelete) {
    if (rootDupeMap.get(f.path)?.contentDiffers) continue;
    pathsToDelete.push(f.path);
  }

  // ── Handle CLAUDE.md collisions ───────────────────────────────────────────
  for (const f of collisionList) {
    if (force || !isTTY) {
      const msg = "CLAUDE.md collision needs manual resolution — run `reconcile` interactively";
      info(`warning: ${msg}`);
      result.collisionWarnings.push(msg);
      result.skipped++;
      continue;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(`\nCLAUDE.md collision: both CLAUDE.md (pack-written) and .claude/CLAUDE.md (pre-existing) exist.\n`);
    process.stdout.write(`  (a) delete root CLAUDE.md   — keeps .claude/CLAUDE.md\n`);
    process.stdout.write(`  (b) delete .claude/CLAUDE.md — keeps root CLAUDE.md\n`);
    process.stdout.write(`  (c) skip — resolve manually\n`);
    const ans = (await rl.question(`Choose [a/b/c]: `)).trim().toLowerCase();
    rl.close();
    if (ans === "a") {
      pathsToDelete.push("CLAUDE.md");
    } else if (ans === "b") {
      pathsToDelete.push(".claude/CLAUDE.md");
    } else {
      info(`skipped: CLAUDE.md collision — resolve manually`);
      result.skipped++;
    }
  }

  // ── Apply via Runner ──────────────────────────────────────────────────────
  const ops: Operation[] = mergeRequests.map(({ root, canonical }) => makeMergeRootToCanonical(root, canonical));
  if (pathsToDelete.length > 0) {
    ops.push(makeDeleteFiles(pathsToDelete));
  }

  if (ops.length > 0) {
    const report = await run(ctx, ops, "apply");
    result.deleted = report.applied.filter(c => c.kind === "delete").length;
    if (report.failed) {
      info(`warning: could not apply change to ${report.failed.change.path}: ${report.failed.error}`);
      result.skipped++;
    }
  }

  // ── Prune dangling hook references (#136) ────────────────────────────────
  if (danglingHookFindings.length > 0) {
    const pruneReport = await run(ctx, [makePruneDanglingHooks()], "apply");
    result.pruned = pruneReport.applied.filter(c => c.kind === "write").length;
    if (pruneReport.failed) {
      info(`warning: could not prune hooks from settings.json: ${pruneReport.failed.error}`);
    }
  }

  return result;
}

export async function reconcileCmd(opts: { dryRun?: boolean; force?: boolean; cwd?: string }): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const dryRun = opts.dryRun ?? false;
  const force = opts.force ?? false;

  // ── Boot via loadProject ──────────────────────────────────────────────────
  const cfgPath = join(cwd, ".claude-ds.json");
  if (!(await exists(cfgPath))) {
    err(".claude-ds.json absent — run `adopt` first");
    process.exit(2);
  }
  let ctx;
  try {
    ctx = await loadProject(cwd);
  } catch (e) {
    err(`invalid .claude-ds.json or manifest: ${(e as Error).message}`);
    process.exit(2);
  }
  const cfg = ctx.cfg;
  const manifest = ctx.manifest;

  // ── Scan for reporting ────────────────────────────────────────────────────
  const deprecatedFindings = await scanDeprecated(cwd, manifest.deprecated_paths);
  const collisionFindings = cfg.claude_md_target === "CLAUDE.md"
    ? await scanClaudeMdCollision(cwd)
    : [];
  const rootDupeFindings = await scanRootDupes(cwd, manifest.deprecated_paths);
  const danglingHookFindings = await scanDanglingHooks(cwd, manifest.deprecated_paths);
  const allFindings = [...deprecatedFindings, ...collisionFindings, ...danglingHookFindings];

  if (allFindings.length === 0 && rootDupeFindings.length === 0) {
    info("reconcile: no orphans or collisions found — tree is clean");
    return;
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const rootDupeMap = new Map(rootDupeFindings.map(f => [f.rootPath, f]));
  const lines: string[] = ["", "reconcile: found the following issues:", ""];
  for (const f of allFindings) {
    const tag =
      f.kind === "collision"     ? "[collision]    " :
      f.kind === "dangling-hook" ? "[dangling-hook]" :
                                   "[orphan]       ";
    lines.push(`  ${tag}  ${f.path}`);
    lines.push(`                  ${f.detail}`);
    const dupe = rootDupeMap.get(f.path);
    if (dupe) {
      const note = dupe.contentDiffers
        ? `content differs from ${dupe.canonicalPath} — merge required before deleting root`
        : `content identical to ${dupe.canonicalPath} — safe to delete root`;
      lines.push(`                  [root-dupe] ${note}`);
    }
  }
  for (const f of rootDupeFindings) {
    if (!deprecatedFindings.some(d => d.path === f.rootPath)) {
      const differs = f.contentDiffers ? " [content differs — merge required]" : " [identical to canonical]";
      lines.push(`  [root-dupe]  ${f.rootPath} → ${f.canonicalPath}${differs}`);
    }
  }
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");

  if (dryRun) {
    const total = allFindings.length + rootDupeFindings.filter(f => !deprecatedFindings.some(d => d.path === f.rootPath)).length;
    info(`[dry-run] ${total} issue(s) found — no files modified`);
    process.exit(0);
  }

  // ── Non-TTY, non-force: can't prompt ──────────────────────────────────────
  const isTTY = Boolean(process.stdin.isTTY);
  if (!force && !isTTY) {
    const collisionList = allFindings.filter(f => f.kind === "collision");
    const deprecatedList = allFindings.filter(f => f.kind === "deprecated");
    if (deprecatedList.length > 0 || collisionList.length > 0) {
      info("reconcile: non-interactive mode — pass --force to delete deprecated orphans");
      process.exit(0);
    }
    return;
  }

  // ── Interactive confirmation for standalone reconcile ─────────────────────
  if (!force && isTTY) {
    const deprecatedList = allFindings.filter(f => f.kind === "deprecated");
    if (deprecatedList.length > 0) {
      if (!(await confirm(`Delete the ${deprecatedList.length} deprecated orphan(s)?`))) {
        info("aborted — no files modified");
        return;
      }
    }
  }

  // ── Delegate to shared logic ──────────────────────────────────────────────
  const result = await runReconcileActions(ctx, { force });

  const parts: string[] = [];
  if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
  if (result.pruned > 0) parts.push(`settings.json pruned`);
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
  info(`reconcile complete — ${parts.length > 0 ? parts.join(", ") : "nothing to do"}`);
}
