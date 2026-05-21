import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseExceptions, gate } from "../lib/exceptions.js";
import { info, err, confirm } from "../lib/log.js";
import { loadProject } from "../lib/project.js";

export async function enforceCmd(opts: { yes?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  const cfgPath = join(cwd, ".claude-ds.json");
  try { await stat(cfgPath); } catch { err(".claude-ds.json absent; run init or adopt first"); process.exit(2); }
  const ctx = await loadProject(cwd);
  const ex = parseExceptions(await readFile(join(cwd, "design-system/exceptions.json"), "utf8"));
  try { gate(ex, ctx.cfg.enforce_threshold, new Date()); } catch (e) { err((e as Error).message); process.exit(2); }
  if (!opts.yes && !(await confirm(`Flip mode warn → block (open exceptions ≤ ${ctx.cfg.enforce_threshold})?`))) { info("aborted"); return; }
  const next = { ...ctx.cfg, mode: "block" as const };
  await writeFile(cfgPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  info("enforce: mode flipped to block");
}
