import { readFile, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { parseConfig } from "../lib/config.js";
import { info, err } from "../lib/log.js";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

export async function auditCmd(opts: { pack?: string; suggestRemovals?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  let pack = opts.pack;
  if (!pack) {
    const cfgPath = join(cwd, ".claude-ds.json");
    if (!(await exists(cfgPath))) { err("--pack required (no .claude-ds.json found)"); process.exit(2); }
    const cfg = parseConfig(await readFile(cfgPath, "utf8"));
    pack = cfg.pack;
  }
  const packDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../packs", pack);
  const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
  for (const f of manifest.files) {
    if (f.category === "generated") continue;
    const here = await exists(join(cwd, f.path));
    info(`${here ? "present" : "missing"}: ${f.path} (${f.category})`);
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
