import { readFile, stat, unlink } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest, DeprecatedPath } from "../lib/manifest.js";
import { parseConfig } from "../lib/config.js";
import { info, err, confirm } from "../lib/log.js";
import { createInterface } from "node:readline/promises";

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

  // ── Require .claude-ds.json ────────────────────────────────────────────────
  const cfgPath = join(cwd, ".claude-ds.json");
  if (!(await exists(cfgPath))) {
    err(".claude-ds.json absent — run `adopt` first");
    process.exit(2);
  }
  let cfg;
  try {
    cfg = parseConfig(await readFile(cfgPath, "utf8"));
  } catch (e) {
    err(`invalid .claude-ds.json: ${(e as Error).message}`);
    process.exit(2);
  }

  // ── Load manifest ──────────────────────────────────────────────────────────
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const packDir = join(repoRoot, "packs", cfg.pack);
  const manifestPath = join(packDir, "manifest.json");
  if (!(await exists(manifestPath))) {
    err(`pack manifest not found: ${manifestPath}`);
    process.exit(2);
  }
  let manifest;
  try {
    manifest = parseManifest(await readFile(manifestPath, "utf8"));
  } catch (e) {
    err(`invalid pack manifest: ${(e as Error).message}`);
    process.exit(2);
  }

  // ── Scan ───────────────────────────────────────────────────────────────────
  const deprecatedFindings = await scanDeprecated(cwd, manifest.deprecated_paths);
  // #34: collision check only applies when the configured target IS root. When the
  // target is non-root (.claude/CLAUDE.md or docs/CLAUDE.md), the root file is handled
  // by `reconform`'s migration path — not a "collision".
  const collisionFindings = cfg.claude_md_target === "CLAUDE.md"
    ? await scanClaudeMdCollision(cwd)
    : [];
  const allFindings = [...deprecatedFindings, ...collisionFindings];

  if (allFindings.length === 0) {
    info("reconcile: no orphans or collisions found — tree is clean");
    return;
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const lines: string[] = ["", "reconcile: found the following issues:", ""];
  for (const f of allFindings) {
    const tag = f.kind === "collision" ? "[collision]" : "[orphan]  ";
    lines.push(`  ${tag}  ${f.path}`);
    lines.push(`             ${f.detail}`);
  }
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");

  if (dryRun) {
    info(`[dry-run] ${allFindings.length} issue(s) found — no files modified`);
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

  // ── Remediate deprecated orphans ──────────────────────────────────────────
  let deleted = 0;
  let skipped = 0;

  const toDelete = (force || isTTY) ? deprecatedList : [];
  for (const f of toDelete) {
    const full = join(cwd, f.path);
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
