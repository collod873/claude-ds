import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "../lib/config.js";
import { parseExceptions, gate } from "../lib/exceptions.js";
import { info, err, confirm } from "../lib/log.js";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

export async function enforceCmd(opts: { yes?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  const cfgPath = join(cwd, ".claude-ds.json");
  if (!(await exists(cfgPath))) { err(".claude-ds.json absent; run init or adopt first"); process.exit(2); }
  const cfg = parseConfig(await readFile(cfgPath, "utf8"));
  const ex = parseExceptions(await readFile(join(cwd, "design-system/exceptions.json"), "utf8"));
  try { gate(ex, cfg.enforce_threshold, new Date()); } catch (e) { err((e as Error).message); process.exit(2); }
  if (!opts.yes && !(await confirm(`Flip mode warn → block (open exceptions ≤ ${cfg.enforce_threshold})?`))) { info("aborted"); return; }
  cfg.mode = "block";
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  info("enforce: mode flipped to block");
}
