import { readFile, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { parseConfig, Config } from "../lib/config.js";
import { info, err } from "../lib/log.js";
import { resolveManifestPath, detectAppDir } from "../lib/paths.js";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

export async function auditCmd(opts: { pack?: string; suggestRemovals?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  let pack = opts.pack;
  let cfg: Config | null = null;
  if (!pack) {
    const cfgPath = join(cwd, ".claude-ds.json");
    if (!(await exists(cfgPath))) { err("--pack required (no .claude-ds.json found)"); process.exit(2); }
    cfg = parseConfig(await readFile(cfgPath, "utf8"));
    pack = cfg.pack;
  } else {
    const cfgPath = join(cwd, ".claude-ds.json");
    if (await exists(cfgPath)) {
      try { cfg = parseConfig(await readFile(cfgPath, "utf8")); } catch { cfg = null; }
    }
  }
  // #47/#34: honor app_dir + claude_md_target when checking presence.
  const appDir = cfg?.app_dir ?? await detectAppDir(cwd);
  const claudeMdTarget = cfg?.claude_md_target ?? "CLAUDE.md";
  const packDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../packs", pack);
  const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
  for (const f of manifest.files) {
    if (f.category === "generated") continue;
    const checkPath = f.path === "CLAUDE.md"
      ? claudeMdTarget
      : resolveManifestPath(f.path, appDir);
    const here = await exists(join(cwd, checkPath));
    const display = (checkPath === f.path) ? f.path : `${f.path} (at ${checkPath})`;
    info(`${here ? "present" : "missing"}: ${display} (${f.category})`);
  }

  // Deprecated-path scan: report any files on disk that should no longer exist.
  // This catches orphans left by prior pack versions — the "lookalike at deprecated path" check
  // from #26. We skip the lookalike.ts short-circuit here by checking deprecated paths directly
  // rather than going through detectLookalikes (which returns present:true, lookalike:null for
  // canonical paths that exist, never inspecting deprecated-path neighbours).
  let orphanCount = 0;
  for (const d of manifest.deprecated_paths) {
    if (await exists(join(cwd, d.path))) {
      info(`orphan (deprecated since ${d.since_version}): ${d.path} — ${d.reason}`);
      orphanCount++;
    }
  }
  if (orphanCount > 0) {
    info(`${orphanCount} deprecated-path orphan(s) found — run \`claude-ds reconcile\` to remove`);
  }

  if (opts.suggestRemovals) info("--suggest-removals: (heuristic) no ad-hoc removals detected at v1");
}
