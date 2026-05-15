import { readFile, stat, unlink } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest, DeprecatedPath } from "../lib/manifest.js";
import { parseConfig } from "../lib/config.js";
import { info, err, confirm } from "../lib/log.js";

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
  const collisionFindings = await scanClaudeMdCollision(cwd);
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

  // ── Prompt or auto-accept (--force) ────────────────────────────────────────
  if (!force && !(await confirm(`Delete the ${allFindings.length} listed file(s)?`))) {
    info("aborted — no files modified");
    return;
  }

  // ── Remediate ──────────────────────────────────────────────────────────────
  let deleted = 0;
  let skipped = 0;
  for (const f of allFindings) {
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

  info(`reconcile complete — ${deleted} deleted, ${skipped} skipped`);
}
