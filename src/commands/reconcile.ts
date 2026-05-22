import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeprecatedPath } from "../lib/manifest.js";
import { loadProject } from "../lib/project.js";
import { info, err, confirm } from "../lib/log.js";
import { createInterface } from "node:readline/promises";
import { scanRootDupes, RootDupeFinding } from "../lib/root-dupes.js";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

export interface ReconcileFinding {
  kind: "deprecated" | "collision";
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


export async function reconcileCmd(opts: { dryRun?: boolean; force?: boolean; cwd?: string }): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const dryRun = opts.dryRun ?? false;
  const force = opts.force ?? false;

  // ── Boot via loadProject ──────────────────────────────────────────────────
  // #84: loadProject is now a pure read — no longer rewrites pre-v0.6 configs as a
  // side effect — so it's safe here. cfg.claude_md_target === "CLAUDE.md" (the
  // parseConfig default) still drives the collision branch correctly because the
  // raw file is untouched until a command opts into the migrateConfig Op.
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

  // ── Scan ───────────────────────────────────────────────────────────────────
  const deprecatedFindings = await scanDeprecated(cwd, manifest.deprecated_paths);
  // #34: collision check only applies when the configured target IS root. When the
  // target is non-root (.claude/CLAUDE.md or docs/CLAUDE.md), the root file is handled
  // by `reconform`'s migration path — not a "collision".
  const collisionFindings = cfg.claude_md_target === "CLAUDE.md"
    ? await scanClaudeMdCollision(cwd)
    : [];
  // #23: root-dupe scan — deprecated root files where canonical design-system/ copy also exists
  const rootDupeFindings = await scanRootDupes(cwd, manifest.deprecated_paths);
  const rootDupePaths = new Set(rootDupeFindings.map(f => f.rootPath));
  const allFindings = [...deprecatedFindings, ...collisionFindings];

  if (allFindings.length === 0 && rootDupeFindings.length === 0) {
    info("reconcile: no orphans or collisions found — tree is clean");
    return;
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  // Build a lookup map for root-dupe findings to annotate deprecated orphan lines
  const rootDupeMap = new Map(rootDupeFindings.map(f => [f.rootPath, f]));
  const lines: string[] = ["", "reconcile: found the following issues:", ""];
  for (const f of allFindings) {
    const tag = f.kind === "collision" ? "[collision]" : "[orphan]  ";
    lines.push(`  ${tag}  ${f.path}`);
    lines.push(`             ${f.detail}`);
    // Annotate deprecated orphans that are also root-dupes (#23)
    const dupe = rootDupeMap.get(f.path);
    if (dupe) {
      const note = dupe.contentDiffers
        ? `content differs from ${dupe.canonicalPath} — merge required before deleting root`
        : `content identical to ${dupe.canonicalPath} — safe to delete root`;
      lines.push(`             [root-dupe] ${note}`);
    }
  }
  // Report root-dupes that aren't already in deprecated findings (edge case)
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

  // ── Prompt or auto-accept (--force / non-TTY) ─────────────────────────────
  // Separate collision findings (CLAUDE.md) from regular deprecated-path orphans.
  // CLAUDE.md collisions get a 3-way prompt because both files may have user content.
  // In --force/non-TTY mode we skip collisions with a warning rather than auto-deleting.
  const collisionList = allFindings.filter(f => f.kind === "collision");
  const deprecatedList = allFindings.filter(f => f.kind === "deprecated");

  const isTTY = Boolean(process.stdin.isTTY);

  if (!force && isTTY) {
    // Interactive mode: confirm all deprecated orphans in bulk, then handle each collision
    if (deprecatedList.length > 0) {
      if (!(await confirm(`Delete the ${deprecatedList.length} deprecated orphan(s)?`))) {
        info("aborted — no files modified");
        return;
      }
    }
  } else if (!force && !isTTY) {
    // Non-TTY, non-force: can't prompt, bail out
    if (deprecatedList.length === 0 && collisionList.length === 0) return;
    if (!(force)) {
      info("reconcile: non-interactive mode — pass --force to delete deprecated orphans");
      process.exit(0);
    }
  }

  // ── Remediate root dupes (content-differs path) ───────────────────────────
  // Root dupes that are content-identical are handled by the normal deprecated-path
  // deletion below. Dupes where content differs need merge-or-skip handling first.
  let deleted = 0;
  let skipped = 0;

  for (const f of rootDupeFindings) {
    if (!f.contentDiffers) continue; // identical — handled by deprecated delete below
    if (!isTTY && !force) {
      // Non-TTY, non-force: can't prompt, bail out
      info(`warning: ${f.rootPath} content differs from ${f.canonicalPath} — run \`reconcile\` interactively to merge, or pass --force to delete root`);
      skipped++;
      continue;
    }
    if (force) {
      // --force: delete root copy unconditionally (canonical wins); user content in root is stale
      try {
        await unlink(join(cwd, f.rootPath));
        info(`deleted: ${f.rootPath} (canonical ${f.canonicalPath} kept; content differed — pass --merge-root to overwrite canonical instead)`);
        deleted++;
      } catch (e) {
        info(`warning: could not delete ${f.rootPath}: ${(e as Error).message}`);
        skipped++;
      }
      continue;
    }
    // Interactive: offer merge root→canonical then delete root
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(`\nRoot dupe with different content: ${f.rootPath}\n`);
    process.stdout.write(`  Canonical: ${f.canonicalPath}\n`);
    process.stdout.write(`  (a) merge root → canonical (overwrites canonical with root content), then delete root\n`);
    process.stdout.write(`  (b) keep canonical as-is, delete root\n`);
    process.stdout.write(`  (c) skip — resolve manually\n`);
    const ans = (await rl.question(`Choose [a/b/c]: `)).trim().toLowerCase();
    rl.close();
    if (ans === "a") {
      try {
        const rootContent = await readFile(join(cwd, f.rootPath), "utf8");
        await writeFile(join(cwd, f.canonicalPath), rootContent, "utf8");
        await unlink(join(cwd, f.rootPath));
        info(`merged: ${f.rootPath} → ${f.canonicalPath}, root deleted`);
        deleted++;
      } catch (e) {
        info(`warning: could not merge ${f.rootPath}: ${(e as Error).message}`);
        skipped++;
      }
    } else if (ans === "b") {
      try {
        await unlink(join(cwd, f.rootPath));
        info(`deleted: ${f.rootPath} (canonical kept)`);
        deleted++;
      } catch (e) {
        info(`warning: could not delete ${f.rootPath}: ${(e as Error).message}`);
        skipped++;
      }
    } else {
      info(`skipped: ${f.rootPath} — resolve manually`);
      skipped++;
    }
  }

  // ── Remediate deprecated orphans ──────────────────────────────────────────
  // Skip any root-dupe paths that were already handled (merged or skipped) above.
  const toDelete = (force || isTTY) ? deprecatedList : [];
  for (const f of toDelete) {
    // Skip root-dupes that differ in content — handled above (merged, deleted, or skipped)
    if (rootDupePaths.has(f.path) && rootDupeFindings.find(r => r.rootPath === f.path)?.contentDiffers) continue;
    const full = join(cwd, f.path);
    if (!(await exists(full))) continue; // already deleted in merge step
    try {
      await unlink(full);
      info(`deleted: ${f.path}`);
      deleted++;
    } catch (e) {
      info(`warning: could not delete ${f.path}: ${(e as Error).message}`);
      skipped++;
    }
  }

  // ── Handle CLAUDE.md collisions ───────────────────────────────────────────
  for (const f of collisionList) {
    if (force || !isTTY) {
      // Safe default: skip — auto-deleting either file could destroy user content
      info(`warning: CLAUDE.md collision needs manual resolution — run \`reconcile\` interactively`);
      skipped++;
      continue;
    }

    // Interactive 3-way prompt
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(`\nCLAUDE.md collision: both CLAUDE.md (pack-written) and .claude/CLAUDE.md (pre-existing) exist.\n`);
    process.stdout.write(`  (a) delete root CLAUDE.md   — keeps .claude/CLAUDE.md\n`);
    process.stdout.write(`  (b) delete .claude/CLAUDE.md — keeps root CLAUDE.md\n`);
    process.stdout.write(`  (c) skip — resolve manually\n`);
    const ans = (await rl.question(`Choose [a/b/c]: `)).trim().toLowerCase();
    rl.close();

    if (ans === "a") {
      try {
        await unlink(join(cwd, "CLAUDE.md"));
        info(`deleted: CLAUDE.md`);
        deleted++;
      } catch (e) {
        info(`warning: could not delete CLAUDE.md: ${(e as Error).message}`);
        skipped++;
      }
    } else if (ans === "b") {
      try {
        await unlink(join(cwd, ".claude", "CLAUDE.md"));
        info(`deleted: .claude/CLAUDE.md`);
        deleted++;
      } catch (e) {
        info(`warning: could not delete .claude/CLAUDE.md: ${(e as Error).message}`);
        skipped++;
      }
    } else {
      info(`skipped: CLAUDE.md collision — resolve manually`);
      skipped++;
    }
  }

  info(`reconcile complete — ${deleted} deleted, ${skipped} skipped`);
}
