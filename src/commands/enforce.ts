import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseExceptions, gate } from "../lib/exceptions.js";
import { info, err, confirm } from "../lib/log.js";
import { loadProject } from "../lib/project.js";
import { run } from "../lib/runner.js";
import { setConfigMode } from "../lib/ops/set-config-mode.js";

export async function enforceCmd(opts: { yes?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  const cfgPath = join(cwd, ".claude-ds.json");
  try { await stat(cfgPath); } catch { err(".claude-ds.json absent; run init or adopt first"); process.exit(2); }
  const ctx = await loadProject(cwd);
  const ex = parseExceptions(await readFile(join(cwd, "design-system/exceptions.json"), "utf8"));
  try { gate(ex, ctx.cfg.enforce_threshold); } catch (e) { err((e as Error).message); process.exit(2); }
  if (!opts.yes && !(await confirm(`Flip mode warn → block (open exceptions ≤ ${ctx.cfg.enforce_threshold})?`))) { info("aborted"); return; }
  const report = await run(ctx, [setConfigMode("block")], "apply");
  if (report.failed) { err(`enforce failed: ${report.failed.error}`); process.exit(2); }
  info("enforce: mode flipped to block");
}
