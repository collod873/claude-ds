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
   * regardless of what other unfixed findings remain.
   */
  extractionCount?: number;
  /**
   * Count of unfixed DRIFT-MISPLACED findings audit flagged as ambiguous (ADR-0015,
   * issue #203). When > 0, the audit breadcrumb routes to `classify`, which owns the
   * keep/move structural decision audit refuses to make.
   */
  ambiguityCount?: number;
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
      if ((ctx.extractionCount ?? 0) > 0 || (ctx.ambiguityCount ?? 0) > 0) {
        const ext = ctx.extractionCount ?? 0;
        const amb = ctx.ambiguityCount ?? 0;
        const clauses: string[] = [];
        if (ext > 0) clauses.push(`extract ${ext} inline ${ext === 1 ? "component" : "components"}`);
        if (amb > 0) clauses.push(`resolve ${amb} ambiguous ${amb === 1 ? "classification" : "classifications"}`);
        message = `run 'claude-ds classify' to ${clauses.join(" and ")}, then re-run 'claude-ds audit'`;
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
      message = "run 'claude-ds audit' to check for new drift after the upgrade";
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
