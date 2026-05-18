import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig, type Config } from "./config.js";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

/**
 * Rewrite a manifest-canonical path through the consumer's configured app_dir.
 * Manifest entries under `app/` are rewritten to `<app_dir>/...`. Everything else passes through.
 * This is the sole I/O boundary translation for #47 — manifest stays grep-friendly with `app/`.
 */
export function resolveManifestPath(manifestPath: string, appDir: string): string {
  if (manifestPath === "app") return appDir;
  if (manifestPath.startsWith("app/")) return appDir + manifestPath.slice(3);
  return manifestPath;
}

/**
 * Detect the project's Next.js app router root. Returns "src/app" if that
 * directory exists (the officially-supported `src/app/` layout), else "app".
 * Result is persisted to .claude-ds.json so future sync/audit/reconform stay consistent
 * even if the consumer later adds a sibling `app/` dir.
 */
export async function detectAppDir(cwd: string): Promise<string> {
  if (await exists(join(cwd, "src", "app"))) return "src/app";
  return "app";
}

/**
 * Find existing CLAUDE.md candidates in priority order:
 *   1. ./CLAUDE.md         (root)
 *   2. .claude/CLAUDE.md   (Claude Code auto-loads)
 *   3. docs/CLAUDE.md
 *
 * Returns relative paths of files that exist.
 */
export async function detectClaudeMdCandidates(cwd: string): Promise<string[]> {
  const candidates = ["CLAUDE.md", ".claude/CLAUDE.md", "docs/CLAUDE.md"];
  const found: string[] = [];
  for (const c of candidates) {
    if (await exists(join(cwd, c))) found.push(c);
  }
  return found;
}

/**
 * Default CLAUDE.md target when none exists. Per #34, NEVER root by default —
 * `.claude/CLAUDE.md` is the safe default because Claude Code auto-loads it
 * and it doesn't collide with project-root README/docs conventions.
 */
export const DEFAULT_CLAUDE_MD_TARGET = ".claude/CLAUDE.md";

/**
 * Load `.claude-ds.json` and, if it predates v0.6 (missing `app_dir` or `claude_md_target`),
 * auto-detect those fields against the on-disk layout and PERSIST them back. Without this,
 * pre-v0.6 projects upgraded to ≥v0.6 silently default to `app_dir="app"` and
 * `claude_md_target="CLAUDE.md"` (see config.ts) and sync writes to the wrong locations
 * — the Crewops migration bug behind reopened #47/#34.
 *
 * Behavior on first run against a pre-v0.6 config:
 *   - app_dir: detected via detectAppDir (src/app/ wins if present, else "app").
 *   - claude_md_target: if `.claude/CLAUDE.md` exists, use it (preferred — least intrusive,
 *     auto-loaded by Claude Code). Else fall back to whatever candidates exist via the
 *     priority order in detectClaudeMdCandidates. With `interactive=true` and multiple
 *     candidates we prompt; with `interactive=false` (--yes / non-tty) we pick automatically.
 *   - Persists ONLY the keys we filled in (preserves any other on-disk keys, like
 *     lookalike_ignore, that parseConfig would otherwise round-trip lossily).
 */
export async function loadConfigWithMigration(
  cwd: string,
  opts: { interactive?: boolean } = {},
): Promise<Config> {
  const cfgPath = join(cwd, ".claude-ds.json");
  const raw = await readFile(cfgPath, "utf8");
  const onDisk = JSON.parse(raw) as Record<string, unknown>;

  const hadAppDir = "app_dir" in onDisk;
  const hadClaudeMdTarget = "claude_md_target" in onDisk;

  let mutated = false;

  if (!hadAppDir) {
    const detected = await detectAppDir(cwd);
    onDisk.app_dir = detected;
    mutated = true;
  }

  if (!hadClaudeMdTarget) {
    // Per #34: NEVER auto-pick root as the migration target. Root may already hold user
    // content (the Crewops scenario) and sync would mutate it. Prefer safe, non-root
    // locations; fall back to the DEFAULT (.claude/CLAUDE.md) which is created on first write.
    const candidates = await detectClaudeMdCandidates(cwd);
    const nonRootCandidates = candidates.filter(c => c !== "CLAUDE.md");
    let target: string;
    if (nonRootCandidates.length === 0) {
      // No safe existing target — use the default. Root CLAUDE.md, if present, is preserved
      // as user content and reconform handles any historical managed block sitting there.
      target = DEFAULT_CLAUDE_MD_TARGET;
    } else if (nonRootCandidates.length === 1) {
      target = nonRootCandidates[0];
    } else if (!opts.interactive) {
      // Non-interactive (--yes / piped): prefer .claude/CLAUDE.md.
      target = nonRootCandidates.find(c => c === ".claude/CLAUDE.md") ?? nonRootCandidates[0];
    } else {
      process.stdout.write(`\nMigrating pre-v0.6 config — multiple CLAUDE.md files found.\nChoose where the managed pointer block should live:\n`);
      nonRootCandidates.forEach((c, i) => process.stdout.write(`  ${i + 1}. ${c}\n`));
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ans = (await rl.question(`Pick [1-${nonRootCandidates.length}]: `)).trim();
      rl.close();
      const idx = Number.parseInt(ans, 10) - 1;
      target = (idx >= 0 && idx < nonRootCandidates.length) ? nonRootCandidates[idx] : nonRootCandidates[0];
    }
    onDisk.claude_md_target = target;
    mutated = true;
  }

  if (mutated) {
    await writeFile(cfgPath, JSON.stringify(onDisk, null, 2) + "\n", "utf8");
  }

  return parseConfig(JSON.stringify(onDisk));
}