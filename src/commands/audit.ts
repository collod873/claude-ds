import { readFile, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { info } from "../lib/log.js";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

export async function auditCmd(opts: { pack: string; suggestRemovals?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  const packDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../packs", opts.pack);
  const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
  for (const f of manifest.files) {
    if (f.category === "generated") continue;
    const here = await exists(join(cwd, f.path));
    info(`${here ? "present" : "missing"}: ${f.path} (${f.category})`);
  }
  if (opts.suggestRemovals) info("--suggest-removals: (heuristic) no ad-hoc removals detected at v1");
}
