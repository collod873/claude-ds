import { stat } from "node:fs/promises";
import { join } from "node:path";

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
