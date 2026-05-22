import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { parseManifest, type Manifest } from "./manifest.js";
import { loadConfig } from "./paths.js";

/**
 * The boot context every command (post-adopt) needs: the consumer cwd, the parsed
 * `.claude-ds.json`, the resolved pack directory, the parsed manifest, an `exists`
 * probe (cwd-relative), and a `decisions` bag the calling command pre-fills with
 * anything it resolved interactively (renames, claude-md target).
 *
 * Frozen on return so Operations / commands cannot mutate the context after load.
 */
export interface ProjectContext {
  cwd: string;
  cfg: Config;
  packDir: string;
  manifest: Manifest;
  exists(path: string): Promise<boolean>;
  decisions: { renames?: Record<string, string>; claudeMdTarget?: string };
}

async function existsAt(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Boot a command: read `.claude-ds.json` (pure — no migration side effect), resolve
 * packDir from this file's location (works in both src/ during dev and dist/ when built),
 * parse the manifest.
 *
 * One seam replaces the 6-line ritual previously duplicated across every command.
 * Pre-adopt commands (init, the pre-config branches of audit/doctor/migrate-layout)
 * cannot use this — they have no config to load.
 *
 * #84: migration of pre-v0.6 configs is now a deliberate `migrateConfig` Op the
 * command opts into via the Runner — no longer a hidden side effect of boot.
 */
export async function loadProject(
  cwd: string,
  decisions: ProjectContext["decisions"] = {},
): Promise<ProjectContext> {
  const cfg = await loadConfig(cwd);
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const packDir = join(repoRoot, "packs", cfg.pack);
  const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));

  const ctx: ProjectContext = {
    cwd,
    cfg,
    packDir,
    manifest,
    exists: (p: string) => existsAt(isAbsolute(p) ? p : join(cwd, p)),
    decisions,
  };
  return Object.freeze(ctx);
}
