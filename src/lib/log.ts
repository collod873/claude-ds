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

type NextStepCommand = "adopt" | "classify" | "audit" | "audit-fix" | "sync" | "reconcile" | "doctor" | "upgrade" | "migrate-layout" | "version" | "reconform" | "enforce";

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
  /**
   * Count of actionable warnings (orphans, deprecated-path matches) that the
   * read-only audit surfaced (#349 F9). When > 0 with no errors, the breadcrumb
   * routes to `audit --fix` instead of "verify the build" — telling the
   * consumer their build compiles while orphans linger is the inconsistent
   * verdict F9 closes. `audit --fix` runs reconcile as a pre-step (#171), so a
   * single command handles every actionable warning the read-only pass listed.
   */
  hasActionableWarnings?: boolean;
  /**
   * For `doctor` (#349 F21): what kind of remaining concern the verdict
   * carries. Picks the verb in the breadcrumb so doctor's `→ Next` names the
   * actual fix, not a generic "run something."
   */
  doctorVerdict?:
    | "clean"
    | "pre-adopt"
    | "scaffold-gap"
    | "root-dupes"
    | "lookalikes"
    | "repair-needed"
    | "upgrade-available"
    | "completeness-findings";
  /**
   * For `upgrade` (#349 F21): differentiates the post-action breadcrumb.
   * `applied` ran a migration chain and bumped the pin; `no-op` was already
   * at the target with nothing to do; `repaired` re-applied a regressed
   * end-state at the current version.
   */
  upgradeOutcome?: "applied" | "no-op" | "repaired";
  /**
   * For `migrate-layout` (#359): keys the post-success breadcrumb on whether
   * the consumer is pre-adopt or already adopted. The old "re-run adopt to
   * proceed" copy was wrong post-adopt — once `.claude-ds.json` exists, the
   * unblocking action is `heal`, not a second `adopt`.
   */
  projectKind?: "adopted" | "pre-adopt";
  /**
   * For `version` (#363): which of the four pinned-vs-installed states the
   * command resolved to. `no-config` → adopt; `up-to-date` → audit;
   * `behind` (pinned < installed) → upgrade; `ahead` (pinned > installed) →
   * update the CLI binary.
   */
  versionState?: "no-config" | "up-to-date" | "behind" | "ahead";
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
      } else if (ctx.hasActionableWarnings) {
        // #349 F9: warnings (orphans, deprecated-path matches) are actionable
        // even though they're not errors — route to the command that resolves
        // them rather than telling the consumer to verify a build while the
        // listed action goes undone.
        message = "run 'claude-ds audit --fix' to resolve the warnings listed above";
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
      // #349 F21: doctor previously printed no breadcrumb, violating the
      // CONTEXT.md "every command ends with a verdict and a → Next" mandate.
      // The verdict it carries — clean, scaffold-gap, repair-needed,
      // upgrade-available — picks which action to name. The pre-adopt path
      // (no .claude-ds.json) routes through `adopt`.
      switch (ctx.doctorVerdict) {
        case "pre-adopt":
          message = "run 'claude-ds adopt' to install the scaffold";
          break;
        case "scaffold-gap":
          message = "run 'claude-ds sync' to restore the missing managed file(s)";
          break;
        case "root-dupes":
          message = "run 'claude-ds audit --fix' to resolve the root-level duplicate(s)";
          break;
        case "lookalikes":
          message = "run 'claude-ds migrate-layout' to rename the lookalike(s) to canonical paths";
          break;
        case "repair-needed":
          message = "run 'claude-ds upgrade' to re-apply the regressed migration end-state(s)";
          break;
        case "upgrade-available":
          message = "run 'claude-ds upgrade' to install the newer pack version";
          break;
        case "completeness-findings":
          message = "review the findings above — delete superseded files, link issues to exceptions, or mark permanent";
          break;
        case "clean":
        default:
          message = `run ${buildCmd} to verify everything compiles`;
          break;
      }
      break;
    case "migrate-layout":
      // #359: pre-adopt projects continue on to `adopt`; an already-adopted
      // project's next move is `heal` (the self-converging command), not a
      // second `adopt`. The auto-commit and the "re-run adopt to proceed" copy
      // were a single defect — both telling the consumer the wrong thing for
      // the post-adopt path.
      message = ctx.projectKind === "adopted"
        ? "run 'claude-ds heal' to converge the project to clean"
        : "run 'claude-ds adopt' to install the scaffold";
      break;
    case "upgrade":
      switch (ctx.upgradeOutcome) {
        case "repaired":
          message = "run 'claude-ds audit' to verify the restored baseline";
          break;
        case "no-op":
          message = "run 'claude-ds audit' to check for drift";
          break;
        case "applied":
        default:
          message = "run 'claude-ds audit' to check for new drift after the upgrade";
          break;
      }
      break;
    case "version":
      // #363: even the informational `version` command must end with a
      // breadcrumb (CONTEXT.md's "Next-step breadcrumb" rule covers every
      // CLI command, not just mutating ones). Route on pinned vs installed:
      // no config → adopt; behind → upgrade; ahead → update the CLI binary;
      // up-to-date → audit (the standard verify step).
      switch (ctx.versionState) {
        case "no-config":
          message = "run 'claude-ds adopt' to install the scaffold";
          break;
        case "behind":
          message = "run 'claude-ds upgrade' to apply pending migrations";
          break;
        case "ahead":
          message = "update the CLI binary to match (or downgrade the .claude-ds.json pin)";
          break;
        case "up-to-date":
        default:
          message = "run 'claude-ds audit' to check for drift";
          break;
      }
      break;
    case "reconform":
      // #363: reconform ends with a summary line ("reconform complete — …")
      // but never a breadcrumb. The post-reconform next step is the standard
      // verify pass.
      message = "run 'claude-ds audit' to check for drift";
      break;
    case "enforce":
      // #363: the post-flip and already-block paths both leave the operator
      // in block mode; the standard verify after a mode change is audit.
      // (The gate-refusal path keeps its inline #362 breadcrumb — it has a
      // command-specific recovery instruction.)
      message = "run 'claude-ds audit' to check for drift";
      break;
  }

  if (message) info(`→ Next: ${message}`);
}

/**
 * Issue #364 — non-TTY callers must not be silently auto-answered "no".
 * Without a TTY there is no human to answer the prompt; the previous code
 * raced `rl.question` against `rl.close` so a closed stdin resolved to `""`
 * — indistinguishable from a real "n", and the command exited 0 as if the
 * user had declined. Per ADR-0016, an unanswered prompt with no human in
 * the loop must fail loud (named, non-zero) rather than fabricate an answer.
 * Exit 3 = "non-TTY: pass --yes (or supply `--answers` for Decision-based
 * commands) so the prompt does not need a human."
 */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    err(`${question} [y/N]: non-TTY, no answer available — pass --yes to confirm non-interactively`);
    process.exit(3);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let ans: string;
  try {
    ans = await rl.question(`${question} [y/N] `);
  } catch {
    ans = "";
  } finally {
    rl.close();
  }
  const v = ans.trim().toLowerCase();
  return v === "y" || v === "yes";
}
