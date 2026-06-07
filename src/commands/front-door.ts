/**
 * PRD #325 sub-issue #331 — the bare-`claude-ds` front door.
 *
 * In a TTY, the bare invocation auto-runs read-only `doctor` structural state
 * + a read-only drift/integrity scan, composes them through the pure
 * `composeDashboardState` brain, prints the rendered dashboard, and offers
 * `[Enter]` to dispatch the recommended next command in-process. Non-TTY
 * bare invocation keeps today's help-output behavior — the cli.ts entry
 * gates on `isTTY()` so this file is only entered on the interactive path.
 *
 * Dispatch is in-process: we re-enter `buildProgram()` with the
 * recommendation's argv rather than shelling out. That keeps the front door
 * one keystroke away from the next right action without spawning a fresh
 * Node process or breaking the `defaults.cwd` test seam.
 */
import { createInterface } from "node:readline/promises";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { parseConfig } from "../lib/config.js";
import { loadPreAdoptProject, loadProject, type ProjectContext } from "../lib/project.js";
import { parseExceptions, type Exception } from "../lib/exceptions.js";
import { scanScaffoldPresence } from "../lib/reports/scaffold-presence.js";
import { scanDriftAndIntegrity } from "../lib/reports/drift-integrity-scan.js";
import { isExtractionNeededFinding, isFixable, type DriftRuleId } from "../lib/drift/index.js";
import { isIntegrityFixable, type IntegrityRuleId } from "../lib/integrity/index.js";
import { scanRootDupes } from "../lib/root-dupes.js";
import { resolveManifestPath } from "../lib/paths.js";
import { detectBuildCommand } from "../lib/log.js";
import { composeDashboardState } from "../lib/dashboard.js";
import { renderDashboard } from "../lib/render/index.js";
import { printLines } from "../lib/render/tty-layer.js";

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

const DEFAULT_PACK = "next-react";

export interface FrontDoorOpts {
  cwd?: string;
  /** When false, skip the [Enter]-to-dispatch readline so tests can capture
   *  the rendered output without hanging on stdin. Defaults to true. */
  interactive?: boolean;
}

export async function frontDoorCmd(opts: FrontDoorOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const interactive = opts.interactive ?? true;

  // Mode detection mirrors `audit` / `doctor`: presence of `.claude-ds.json`
  // discriminates the boot path. A malformed config falls back to pre-adopt
  // so the dashboard never crashes on a broken project — the user can still
  // read the recommendation and recover.
  const cfgPath = join(cwd, ".claude-ds.json");
  const hasCfg = await exists(cfgPath);
  let pack = DEFAULT_PACK;
  if (hasCfg) {
    try {
      const cfg = parseConfig(await readFile(cfgPath, "utf8"));
      pack = cfg.pack;
    } catch {
      // Fall back to default pack; the brain will recommend adopt anyway.
    }
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const packDir = join(repoRoot, "packs", pack);
  const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));

  let ctx: ProjectContext;
  if (hasCfg) {
    try {
      ctx = await loadProject(cwd);
    } catch {
      ctx = await loadPreAdoptProject(cwd, { pack, packDir, manifest });
    }
  } else {
    ctx = await loadPreAdoptProject(cwd, { pack, packDir, manifest });
  }

  const { appDir, claudeMdTarget } = ctx.auditConfig;

  // Scaffold presence — same scan `audit` runs, but verbose:false so the
  // returned `lines` are suppressed in favor of the dashboard's "Scaffold: N/M"
  // summary line. We only consume the structured `present`/`total`.
  const scaffold = await scanScaffoldPresence(ctx, {
    manifest,
    appDir,
    claudeMdTarget,
    verbose: false,
  });

  // Missing managed files — same shape doctor's adopted branch computes (#58
  // honors app_dir when resolving manifest paths).
  const managedFiles = manifest.files.filter(f => f.category === "managed");
  let missingManaged = 0;
  for (const f of managedFiles) {
    const resolvedPath = resolveManifestPath(f.path, appDir);
    if (!(await exists(join(cwd, resolvedPath)))) missingManaged++;
  }

  // Root-level dupes of canonical design-system/ files (#23).
  const rootDupes = await scanRootDupes(cwd, manifest.deprecated_paths);

  // Read-only audit: skip the drift scan entirely in pre-adopt (no scaffold
  // means design-system/ likely isn't there). In adopted mode, run the same
  // drift+integrity scan `audit` uses and apply exceptions so the dashboard
  // counts match what the user would see from `audit` itself.
  let findings: Array<{ ruleId: string; file: string; message: string }> = [];
  let extractionCount = 0;
  let unfixableCount = 0;
  if (ctx.kind === "adopted") {
    const exceptionsPath = join(cwd, "design-system/exceptions.json");
    let exceptions: Exception[] = [];
    if (await exists(exceptionsPath)) {
      try {
        exceptions = parseExceptions(await readFile(exceptionsPath, "utf8"));
      } catch {
        // Malformed exceptions.json — audit catches the parse error elsewhere.
      }
    }
    const suppressed = new Set(exceptions.map(e => `${e.rule}:${e.path}`));

    const driftIntegrity = await scanDriftAndIntegrity(ctx);
    const active = driftIntegrity.findings.filter(
      f => !suppressed.has(`${f.ruleId}:${f.file}`),
    );
    findings = active.map(f => ({ ruleId: f.ruleId, file: f.file, message: f.message }));
    extractionCount = active.filter(isExtractionNeededFinding).length;
    unfixableCount = active.filter(f => {
      if (isExtractionNeededFinding(f)) return true;
      if (f.ruleId.startsWith("INTEGRITY-")) {
        return !isIntegrityFixable(f.ruleId as IntegrityRuleId);
      }
      return !isFixable(f.ruleId as DriftRuleId);
    }).length;
  }

  const buildCmd = await detectBuildCommand(cwd);

  const state = composeDashboardState({
    cwd,
    mode: ctx.kind === "adopted" ? "adopted" : "pre-adopt",
    pack,
    scaffold: { present: scaffold.present, total: scaffold.total },
    missingManaged,
    rootDupes: rootDupes.length,
    findings,
    extractionCount,
    unfixableCount,
    buildCmd,
  });

  printLines(renderDashboard(state));

  if (interactive && state.recommendedNext) {
    await offerEnterToDispatch(state.recommendedNext.command, { cwd });
  }
}

/**
 * Ask the user whether to run the recommendation. Empty input ([Enter]) →
 * dispatch; any other input → exit silently. Non-claude-ds recommendations
 * (the build command on a clean tree) are surfaced but never dispatched —
 * that's the user's tool, not ours.
 */
async function offerEnterToDispatch(
  command: string,
  ctxOpts: { cwd: string },
): Promise<void> {
  if (!command.startsWith("claude-ds ")) return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await rl.question(`[Enter] to run \`${command}\`, anything else to cancel: `);
  } catch {
    answer = "x";
  } finally {
    rl.close();
  }
  if (answer.trim() !== "") return;

  // In-process dispatch: re-enter buildProgram() with the recommendation's
  // argv minus the "claude-ds" prefix. Going through commander preserves the
  // defaults.cwd seam and the existing exitOverride path the test runner sets.
  const argv = command.split(/\s+/).slice(1);
  const { buildProgram } = await import("../cli.js");
  await buildProgram({ cwd: ctxOpts.cwd }).parseAsync(["node", "claude-ds", ...argv]);
}
