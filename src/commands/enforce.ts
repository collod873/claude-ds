import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseExceptions, gate } from "../lib/exceptions.js";
import { info, err, confirm, printNextStep } from "../lib/log.js";
import { loadProject } from "../lib/project.js";
import { run } from "../lib/runner.js";
import { setConfigMode } from "../lib/ops/set-config-mode.js";

export async function enforceCmd(opts: { yes?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  const cfgPath = join(cwd, ".claude-ds.json");
  try { await stat(cfgPath); } catch { err(".claude-ds.json absent; run init or adopt first"); process.exit(2); }
  const ctx = await loadProject(cwd);
  const ex = parseExceptions(await readFile(join(cwd, "design-system/exceptions.json"), "utf8"));
  try {
    gate(ex, ctx.cfg.enforce_threshold);
  } catch (e) {
    err((e as Error).message);
    // #362: gate refusal previously left the operator with no recovery path.
    // Name the inspection command + both ways out (close exceptions, raise
    // the threshold) so a "nothing-to-do" exit becomes self-explanatory.
    info("→ Next: run 'claude-ds audit', then close some exceptions (or raise enforce_threshold in .claude-ds.json)");
    process.exit(2);
  }
  // #362: idempotency — when the project is already in block mode, say so
  // instead of falsely claiming a flip. Branch *before* the confirm so an
  // operator re-running the command isn't asked to approve a no-op either.
  if (ctx.cfg.mode === "block") {
    info("enforce: already in block mode — nothing to do");
    // #363: every command ends with a breadcrumb — even the no-op path.
    printNextStep("enforce", {});
    return;
  }
  // #364: interactive cancel must fail loud (stderr + exit 130) per ADR-0016.
  if (!opts.yes && !(await confirm(`Flip mode warn → block (open exceptions ≤ ${ctx.cfg.enforce_threshold})?`))) { err("aborted"); process.exit(130); }
  const report = await run(ctx, [setConfigMode("block")], "apply");
  if (report.failed) { err(`enforce failed: ${report.failed.error}`); process.exit(2); }
  info("enforce: mode flipped to block");
  printNextStep("enforce", {});
}
