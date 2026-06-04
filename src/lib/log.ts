import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
export function info(msg: string): void { console.log(msg); }
export function err(msg: string): void { console.error(msg); }

export async function detectBuildCommand(cwd: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    if (pkg.scripts?.build) return "npm run build";
    if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) return "npx tsc";
  } catch {}
  return "your build (e.g. npm run build)";
}

type NextStepCommand = "adopt" | "classify" | "audit" | "audit-fix" | "sync" | "reconcile" | "doctor";

interface NextStepContext {
  hasFindings?: boolean;
  buildCmd?: string;
  /**
   * Count of unfixed DRIFT-RAW-PRIMITIVE findings that need extraction (ADR-0015).
   * When > 0, the audit breadcrumb routes to `classify` — the unblocking action —
   * with the specific "extract N inline components" wording. Takes priority over
   * the generic unfixable-findings message below.
   */
  extractionCount?: number;
  /**
   * Count of remaining findings audit cannot auto-fix (PRD #241 / sub-issue #245):
   * report-only relocate rules (DRIFT-MISPLACED, DRIFT-MISCLASSIFIED-*),
   * INTEGRITY-UNRESOLVABLE-IMPORT, deferred extraction-needed RAW-PRIMITIVE.
   * When > 0, the audit breadcrumb routes to `classify` instead of `audit --fix`
   * so the tool never tells the consumer to run a command that won't help.
   */
  unfixableCount?: number;
  /**
   * True when the tree has consumer-authored DS tier files for classify to
   * organize (PRD #241 / sub-issue #245). Routes sync's breadcrumb to
   * `classify` instead of `audit`, matching the documented adopt → classify →
   * audit flow.
   */
  brownfield?: boolean;
}

export function printNextStep(command: NextStepCommand, ctx: NextStepContext): void {
  const buildCmd = ctx.buildCmd ?? "your build (e.g. npm run build)";
  let message: string | null = null;

  switch (command) {
    case "adopt":
      message = "run 'claude-ds classify --src <dir>' to migrate existing components";
      break;
    case "classify":
      message = "run 'claude-ds audit' to check for drift";
      break;
    case "audit":
      if ((ctx.extractionCount ?? 0) > 0) {
        const ext = ctx.extractionCount ?? 0;
        message = `run 'claude-ds classify' to extract ${ext} inline ${ext === 1 ? "component" : "components"}, then re-run 'claude-ds audit'`;
      } else if ((ctx.unfixableCount ?? 0) > 0) {
        message = "run 'claude-ds classify' to address findings audit can't auto-repair";
      } else if (ctx.hasFindings) {
        message = "run 'claude-ds audit --fix' to auto-repair, or 'claude-ds audit --except' to register exceptions";
      } else {
        message = `run ${buildCmd} to verify everything compiles`;
      }
      break;
    case "audit-fix":
      message = `run ${buildCmd} to verify no breakage was introduced`;
      break;
    case "sync":
      message = ctx.brownfield
        ? "run 'claude-ds classify' to organize existing design-system files"
        : "run 'claude-ds audit' to check for new drift after the upgrade";
      break;
    case "reconcile":
      message = "run 'claude-ds audit' to check for drift";
      break;
    case "doctor":
      return;
  }

  if (message) info(`→ Next: ${message}`);
}

export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let ans: string;
  try {
    ans = await Promise.race([
      rl.question(`${question} [y/N] `),
      new Promise<string>((resolve) => rl.once("close", () => resolve(""))),
    ]);
  } catch {
    ans = "";
  } finally {
    rl.close();
  }
  const v = ans.trim().toLowerCase();
  return v === "y" || v === "yes";
}
