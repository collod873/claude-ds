import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ColorAdapter } from "./render/color.js";
import { loadColorAdapter } from "./render/tty-layer.js";
/**
 * `--json` mode suppression (issue #408). When a command runs with
 * `--json`, every `info()` chatter line is silenced so the final JSON
 * document is the entirety of stdout — the headless contract a verifying
 * agent depends on. `err()` still goes to stderr (machine-readable surface
 * is stdout; diagnostics on stderr are fine).
 *
 * Module-level state because the existing command bodies sprinkle `info()`
 * across many call sites; touching every one with a `quiet?: boolean` flag
 * would balloon the diff for no contract benefit.
 */
let jsonModeActive = false;
export function setJsonMode(active: boolean): void { jsonModeActive = active; }
export function isJsonMode(): boolean { return jsonModeActive; }

export function info(msg: string): void {
  if (jsonModeActive) return;
  console.log(msg);
}
export function err(msg: string): void { console.error(msg); }

/**
 * Issue #370 — TTY-gated color adapter for the commands that still emit plain
 * `info()` / `err()` lines. Returns the picocolors-backed adapter on a real
 * TTY (so phase headers / verdict lines pick up the same color band the
 * dashboard and front door use) and the identity adapter otherwise. Off-TTY
 * — the agent surface — the byte stream stays byte-identical to today.
 *
 * Resolved on each call rather than at module load so tests (and any other
 * mid-process TTY-state change) see the current `process.stdout.isTTY` value.
 */
export function colors(): ColorAdapter {
  return loadColorAdapter();
}

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
  // ADR-0013 / #454: a `→ Next:` breadcrumb is a promise that running it
  // advances the project toward clean. The next-step-liveness gate runs each
  // one against the post-command tree and flags any that change no state (a
  // read-only `audit`/build check) or refuse — those dead-end the consumer.
  // So read-only VERIFICATION guidance is emitted under a distinct `→ Verify:`
  // prefix instead: it's a thing to run to confirm, not the next ACTION that
  // moves state. The liveness rule only grades `Next:` lines, so verification
  // tips no longer register as dead ends, and the consumer still sees them.
  let verify = false;

  switch (command) {
    case "adopt":
      // The `<dir>` placeholder isn't runnable as printed and the migration
      // path only exists on a brownfield tree with loose components. Routed as
      // verification-grade guidance (not a `→ Next:` action) so it isn't graded
      // as a dead-end runnable step; the front door owns the real next action.
      message = "have loose components to organize? run 'claude-ds classify --src <their-dir>' to migrate them";
      verify = true;
      break;
    case "classify":
      message = "run 'claude-ds audit' to check for drift";
      verify = true;
      break;
    case "audit":
      // C2 (#414): route every finding-class breadcrumb at `heal`, the single
      // self-converging entry. Naming `classify` / `audit --fix` / `sync` here
      // would be asking the operator to run a loop step the tool auto-runs —
      // the "homework for self-loop work" defect C2 closes. `audit --except`
      // stays in the with-findings line because exceptions are a deliberate
      // operator decision, not a loop step heal walks.
      if ((ctx.extractionCount ?? 0) > 0) {
        const ext = ctx.extractionCount ?? 0;
        message = `run 'claude-ds heal' to extract ${ext} inline ${ext === 1 ? "component" : "components"} and converge`;
      } else if ((ctx.unfixableCount ?? 0) > 0) {
        message = "run 'claude-ds heal' to address findings audit can't auto-repair";
      } else if (ctx.hasFindings) {
        message = "run 'claude-ds heal' to auto-repair, or 'claude-ds audit --except' to register exceptions";
      } else if (ctx.hasActionableWarnings) {
        // #349 F9: warnings (orphans, deprecated-path matches) are actionable
        // even though they're not errors. Route through `heal` — same self-
        // converging entry the finding paths use — instead of `audit --fix`.
        message = "run 'claude-ds heal' to resolve the warnings listed above";
      } else {
        message = `run ${buildCmd} to verify everything compiles`;
        verify = true;
      }
      break;
    case "audit-fix":
      message = `run ${buildCmd} to verify no breakage was introduced`;
      verify = true;
      break;
    case "sync":
      // C2 (#414): brownfield route used to name `classify` (a loop step heal
      // auto-runs) — now `heal` itself, the single self-converging entry. The
      // greenfield (clean) tail is verification-grade (`audit` is read-only and
      // is not a loop step), so it goes out as a `→ Verify:` tip, not a `→ Next:`
      // action the liveness gate would grade as a dead end.
      //
      // #451: sync just wrote managed files, so the tree is now dirty. A bare
      // `claude-ds heal` would refuse on that dirty tree — the sync→heal wedge.
      // Steer to `heal --allow-dirty`, the authorized override heal already
      // applies to its own inner sub-commands, so the suggested next step
      // actually runs instead of dead-ending on a clean-tree refusal.
      if (ctx.brownfield) {
        message = "run 'claude-ds heal --allow-dirty' to organize the existing design-system files sync just wrote";
      } else {
        message = "run 'claude-ds audit' to check for new drift after the upgrade";
        verify = true;
      }
      break;
    case "reconcile":
      message = "run 'claude-ds audit' to check for drift";
      verify = true;
      break;
    case "doctor":
      // #349 F21: doctor previously printed no breadcrumb, violating the
      // CONTEXT.md "every command ends with a verdict and a → Next" mandate.
      // C2 (#414) rerouted every fixable-state verdict at `heal` — the single
      // self-converging entry — instead of naming the loop step (`sync`,
      // `audit --fix`, `migrate-layout`, `upgrade`) the operator would have to
      // pick. `pre-adopt` and `clean` (no plan exists) keep their direct
      // breadcrumbs because heal isn't the right action there.
      switch (ctx.doctorVerdict) {
        case "pre-adopt":
          message = "run 'claude-ds adopt' to install the scaffold";
          break;
        case "scaffold-gap":
          message = "run 'claude-ds heal' to restore the missing managed file(s)";
          break;
        case "root-dupes":
          message = "run 'claude-ds heal' to resolve the root-level duplicate(s)";
          break;
        case "lookalikes":
          message = "run 'claude-ds heal' to rename the lookalike(s) to canonical paths";
          break;
        case "repair-needed":
          message = "run 'claude-ds heal' to re-apply the regressed migration end-state(s)";
          break;
        case "upgrade-available":
          message = "run 'claude-ds heal' to install the newer pack version";
          break;
        case "completeness-findings":
          message = "review the findings above — delete superseded files, link issues to exceptions, or mark permanent";
          break;
        case "clean":
        default:
          message = `run ${buildCmd} to verify everything compiles`;
          verify = true;
          break;
      }
      break;
    case "migrate-layout":
      // #359 / #454: pre-adopt projects continue on to `adopt` (a real state-
      // advancing action). An already-adopted project that just finished
      // migrate-layout is at a clean fixed point, so a `→ Next: run heal`
      // breadcrumb dead-ends — heal advances no state (and on a tree that still
      // needs work, fails loudly). Surface heal as verification-grade guidance
      // instead, so it isn't graded as a runnable next step that goes nowhere.
      if (ctx.projectKind === "adopted") {
        message = "run 'claude-ds heal' any time to re-converge the project to clean";
        verify = true;
      } else {
        message = "run 'claude-ds adopt' to install the scaffold";
      }
      break;
    case "upgrade":
      switch (ctx.upgradeOutcome) {
        case "repaired":
          message = "run 'claude-ds audit' to verify the restored baseline";
          verify = true;
          break;
        case "no-op":
          message = "run 'claude-ds audit' to check for drift";
          verify = true;
          break;
        case "applied":
        default:
          message = "run 'claude-ds audit' to check for new drift after the upgrade";
          verify = true;
          break;
      }
      break;
    case "version":
      // #363: even the informational `version` command must end with a
      // breadcrumb (CONTEXT.md's "Next-step breadcrumb" rule covers every
      // CLI command, not just mutating ones). C2 (#414) reroutes the `behind`
      // branch at `heal` (was `upgrade`) so the operator gets the single self-
      // converging entry, not the bare loop step.
      switch (ctx.versionState) {
        case "no-config":
          message = "run 'claude-ds adopt' to install the scaffold";
          break;
        case "behind":
          message = "run 'claude-ds heal' to apply pending migrations";
          break;
        case "ahead":
          message = "update the CLI binary to match (or downgrade the .claude-ds.json pin)";
          break;
        case "up-to-date":
        default:
          message = "run 'claude-ds audit' to check for drift";
          verify = true;
          break;
      }
      break;
    case "reconform":
      // #363: reconform ends with a summary line ("reconform complete — …")
      // but never a breadcrumb. The post-reconform verify pass is read-only
      // audit — verification guidance, not a state-advancing next action.
      message = "run 'claude-ds audit' to check for drift";
      verify = true;
      break;
    case "enforce":
      // #363: the post-flip and already-block paths both leave the operator
      // in block mode; the standard verify after a mode change is read-only
      // audit. (The gate-refusal path keeps its inline #362 breadcrumb — it has
      // a command-specific recovery instruction.)
      message = "run 'claude-ds audit' to check for drift";
      verify = true;
      break;
  }

  // `→ Verify:` for read-only checks, `→ Next:` for state-advancing actions.
  // The next-step-liveness gate (#454 / ADR-0013) grades only `Next:` lines, so
  // a read-only check no longer reads as a dead-end runnable step while staying
  // visible to the consumer.
  if (message) info(`→ ${verify ? "Verify" : "Next"}: ${message}`);
}

/**
 * Issue #364 — non-TTY callers must not be silently auto-answered "no".
 * Without a TTY there is no human to answer the prompt; the previous code
 * raced `rl.question` against `rl.close` so a closed stdin resolved to `""`
 * — indistinguishable from a real "n", and the command exited 0 as if the
 * user had declined. Per ADR-0023, an unanswered prompt with no human in
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
