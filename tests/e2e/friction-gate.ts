/**
 * PRD #439 — friction gate + baseline ratchet (the closing edge of the loop).
 *
 * Drives the **real built CLI** through the real command sequence — the
 * post-adopt journey on a shared tree (`adopt → heal → audit --fix → doctor →
 * classify → sync → reconcile → upgrade → version → enforce → reconform → front
 * door`) plus alternate-tree captures of surfaces the shared tree can't show
 * (`greet` pre-adopt, greenfield `init`, git-seeded `migrate-layout`) and an
 * interactive PTY front-door capture — against copies of the harvested
 * `crewops-snapshot` fixture, captures the rendered stdout/stderr of each step,
 * runs `scanFriction` over it (with a real next-step runner injected), and
 * reconciles the resulting findings against a committed `friction-baseline`.
 *
 * The ratchet (PRD #439 user story 14):
 *   - Any finding whose stable `key` is NOT in the baseline is a REGRESSION and
 *     fails the gate. New friction ⇒ fail.
 *   - Baseline keys may only be REMOVED across commits, never added. The gate
 *     never auto-writes the baseline; closing a friction issue means hand-
 *     deleting its key and the gate refusing
 *     to stay green if that key's finding still reproduces.
 *   - A baseline key that NO LONGER reproduces is reported (`stale`) so a fix
 *     can burn its entry down, but it does not fail the gate — the operator
 *     removes it deliberately.
 *
 * Headless contract is intact: the captured bytes come from the SAME built CLI
 * a user runs (no test-only rendering path), forced non-TTY/no-color, so they
 * are byte-for-byte what a TTY-blind agent — and the friction detectors — read
 * from stdout/stderr. The front-door step is the bare no-arg invocation, the
 * literal front door of the CLI.
 *
 * This module is a thin orchestrator over `harness.ts`'s capture helpers and
 * `friction-detector.ts`'s pure scan; the friction policy (thresholds, rules)
 * lives in the detector, the ratchet policy lives here.
 */
import { spawn, execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanFriction,
  parseNextSteps,
  type CapturedStep,
  type FrictionFinding,
  type NextStepRunResult,
} from "../../src/lib/friction-detector.js";
import {
  writeGoldenOutput,
  assertGoldenOutput,
  captureInteractive,
  normalizeScratchPath,
} from "./harness.js";

/**
 * How many kind-less atoms the gate injects into the scratch copy to manufacture
 * the brownfield "wall of repetition" a real adopter with many unclassified
 * components hits. Above {@link REPETITION_THRESHOLD} (12) so heal's per-file
 * `fixed [DRIFT-META-KIND-MISSING]` lines trip the `repetition` rule. Injected
 * at runtime — NOT committed as stub files — so the shared `crewops-snapshot`
 * fixture stays pristine for the #416 tripwire and `crewops-snapshot.test.ts`
 * (PRD #443).
 */
const BROWNFIELD_ATOM_COUNT = 15;

/** The committed baseline file shape — a flat list of accepted friction keys. */
export interface FrictionBaseline {
  /** Every currently-accepted friction key (the ratchet's ledger). */
  keys: string[];
  /**
   * key → the documented condition under which the key may be deleted
   * (ADR-0003). Every key MUST carry a non-empty trigger; `keysMissingTriggers`
   * enforces it so a finding can never enter the ledger without a burn-down.
   */
  removalTriggers: Record<string, string>;
}

/** The reconciliation verdict the gate asserts on. */
export interface RatchetResult {
  /** Findings present in this run, keyed and deduped (from `scanFriction`). */
  findings: FrictionFinding[];
  /** Findings NOT in the baseline — regressions. Non-empty ⇒ gate FAILS. */
  regressions: FrictionFinding[];
  /** Baseline keys that no longer reproduce — removable, do NOT fail the gate. */
  stale: string[];
  /** True iff there are zero regressions. */
  pass: boolean;
}

export interface RunFrictionGateOpts {
  /** Absolute path to the harvested snapshot fixture (copied, never mutated). */
  fixtureDir: string;
  /** Absolute path to the built CLI entry — `<repo>/dist/cli.js`. */
  cliPath: string;
  /** Pack passed to `adopt --pack`. Defaults to `next-react`. */
  pack?: string;
  /** Per-step subprocess timeout. Default 90_000 ms. */
  timeoutMs?: number;
  /**
   * When set, the captured rendered output of each step is goldened here
   * (`writeGoldenOutput`), so any change to user-facing output is a reviewable
   * diff (PRD #439 user story 20).
   */
  goldenDir?: string;
}

/**
 * Baseline keys with no non-empty removal trigger — a violation of the ADR-0003
 * invariant that every accepted finding documents how it burns down. The gate
 * fails on a non-empty result, so a key can never sit in the ledger without a
 * fix plan. Pure — unit-testable.
 */
export function keysMissingTriggers(baseline: FrictionBaseline): string[] {
  return baseline.keys.filter((k) => !baseline.removalTriggers[k]?.trim());
}

/** Reconcile a run's findings against a baseline. Pure — unit-testable. */
export function reconcile(
  findings: FrictionFinding[],
  baseline: FrictionBaseline,
): RatchetResult {
  const baselineKeys = new Set(baseline.keys);
  const foundKeys = new Set(findings.map((f) => f.key));
  const regressions = findings.filter((f) => !baselineKeys.has(f.key));
  const stale = [...baselineKeys].filter((k) => !foundKeys.has(k));
  return { findings, regressions, stale, pass: regressions.length === 0 };
}

/** A captured run plus the scratch tree it ran against (for the next-step runner). */
export interface CaptureResult {
  steps: CapturedStep[];
  /** The post-run tree the sequence mutated — the runner copies it per suggestion. */
  workDir: string;
}

/**
 * Run the real command sequence against a fresh copy of the snapshot and return
 * the captured steps plus the post-run tree. The front-door step is the bare
 * no-arg CLI invocation — the literal front door — captured exactly as a
 * piped/agent consumer sees it.
 */
export async function captureFrictionRun(
  opts: RunFrictionGateOpts,
): Promise<CaptureResult> {
  const pack = opts.pack ?? "next-react";
  const timeoutMs = opts.timeoutMs ?? 90_000;

  if (!existsSync(opts.cliPath)) {
    throw new Error(
      `friction-gate: CLI not built — ${opts.cliPath} does not exist (run \`npm run build\`)`,
    );
  }
  if (!existsSync(opts.fixtureDir)) {
    throw new Error(`friction-gate: fixture missing at ${opts.fixtureDir}`);
  }

  const work = await mkdtemp(join(tmpdir(), "e2e-friction-"));
  await cp(opts.fixtureDir, work, { recursive: true });
  // Manufacture the brownfield repetition surface in the scratch copy only.
  await injectBrownfieldSurface(work);

  const steps: CapturedStep[] = [];
  steps.push(await runStep("adopt", [opts.cliPath, "adopt", "--pack", pack, "--yes"], work, timeoutMs));

  // Interactive (TTY) capture of the bare front door, on the POST-ADOPT tree —
  // the dashboard + commitment gate a human sees, which the piped steps below
  // never render (#443). stdin is /dev/null, so the gate cancels and the tree is
  // untouched, leaving the headless sequence unaffected. It runs here (before
  // heal mutates the tree) but is appended to `steps` LAST so it always goldens
  // as the highest-numbered `NN-front-door-interactive.txt` step.
  const interactive = await captureInteractive({
    name: "front-door-interactive",
    cliPath: opts.cliPath,
    args: [],
    cwd: work,
    timeoutMs,
  });

  steps.push(await runStep("heal", [opts.cliPath, "heal"], work, timeoutMs));
  // `audit --fix` gates on a clean tree; heal leaves managed writes behind, so
  // pass `--allow-dirty` for the same reason heal runs it inline. This is the
  // real fixer surface a consumer reaches for after heal.
  steps.push(await runStep("audit-fix", [opts.cliPath, "audit", "--fix", "--allow-dirty"], work, timeoutMs));

  // Standalone diagnostic surface — the commands a consumer runs on their own to
  // ask "what's here / what else can I do" once the tree is healed. The original
  // gate only graded the `adopt → heal → audit → front door` journey, leaving
  // every other command's human output ungraded for friction (the surface where
  // a wall of lines, jargon, or a dead-end `→ Next:` actually bites). These are
  // the read-only / `--dry-run` commands that need no argument, no git repo, and
  // no network, so they stay deterministic on the committed snapshot. All are
  // run `--dry-run` where they mutate, so one step never corrupts the next's
  // input:
  //   doctor          — health checklist + verdict
  //   classify        — classification plan (dry-run; never moves files)
  //   sync            — managed-file diff (dry-run; pack is bundled with the CLI,
  //                     NOT fetched — "never fetched from remote tags", sync.ts)
  //   reconcile       — orphan/collision report (dry-run; never deletes)
  //   upgrade         — version-bump preview (dry-run; pins to installed CLI, no fetch)
  //   version         — installed/pinned report (--offline; no remote tag lookup)
  //   enforce         — WARN→BLOCK flip; stdin is /dev/null so it cancels at the
  //                     prompt and mutates nothing — grades the prompt-cancel surface
  //   reconform       — companion-backfill plan (dry-run; never writes). Its body
  //                     echoes absolute paths, so runStep rewrites the scratch
  //                     cwd → `<project>` (normalizeScratchPath) to keep the
  //                     golden reproducible.
  steps.push(await runStep("doctor", [opts.cliPath, "doctor"], work, timeoutMs));
  steps.push(await runStep("classify", [opts.cliPath, "classify", "--dry-run"], work, timeoutMs));
  steps.push(await runStep("sync", [opts.cliPath, "sync", "--dry-run"], work, timeoutMs));
  steps.push(await runStep("reconcile", [opts.cliPath, "reconcile", "--dry-run"], work, timeoutMs));
  steps.push(await runStep("upgrade", [opts.cliPath, "upgrade", "--dry-run"], work, timeoutMs));
  steps.push(await runStep("version", [opts.cliPath, "version", "--offline"], work, timeoutMs));
  steps.push(await runStep("enforce", [opts.cliPath, "enforce"], work, timeoutMs));
  steps.push(await runStep("reconform", [opts.cliPath, "reconform", "--dry-run"], work, timeoutMs));

  // Alternate-tree captures — commands whose surface only exists on a tree the
  // main post-adopt `work` can't represent, so each runs on its OWN fresh copy
  // of the snapshot (its `workDir` rides on the step so the next-step runner
  // judges its `→ Next:` against the right tree):
  //   greet           — the FIRST-RUN bare invocation: only fires when no
  //                     `.claude-ds.json` exists, which the adopted `work` never
  //                     is. Captured pre-adopt — the highest-stakes surface a
  //                     brand-new consumer sees.
  //   init            — greenfield BLOCK-mode bootstrap; conflicts with an
  //                     already-adopted tree, so it needs a clean copy.
  //   migrate-layout  — does `git mv`, so its copy is `git init`-seeded first.
  // Still NOT graded (one concrete blocker left): `migrate` needs a component
  // sitting OUTSIDE the scaffold to move, and the harvested snapshot has none —
  // grading it would mean hand-planting an artificial component, which cuts
  // against PRD #439's "harvest, don't hand-author". Add it if/when the snapshot
  // grows a real loose component.
  steps.push(await captureFreshCopy(opts, "greet", [opts.cliPath], { adopt: false }));
  steps.push(await captureFreshCopy(opts, "init", [opts.cliPath, "init", "--pack", pack, "--yes"], { adopt: false }));
  steps.push(await captureFreshCopy(opts, "migrate-layout", [opts.cliPath, "migrate-layout"], { adopt: true, git: true }));

  // Front door: the bare no-arg invocation — what a user types to "check in".
  steps.push(await runStep("front-door", [opts.cliPath], work, timeoutMs));

  // Append the interactive capture last (it always goldens as the highest-
  // numbered step). Null ⇒ `script(1)` is unavailable; skip rather than block
  // the gate — the interactive findings then read as `stale` (gone), which the
  // ratchet reports without failing.
  if (interactive) {
    steps.push(interactive);
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "[friction-gate] interactive PTY capture skipped (script(1) unavailable) — " +
        "interactive-only findings will read as stale this run",
    );
  }

  if (opts.goldenDir) {
    await mkdir(opts.goldenDir, { recursive: true });
    await reconcileGoldens(steps, opts.goldenDir);
  }

  return { steps, workDir: work };
}

/**
 * Reconcile the run's rendered output against the COMMITTED goldens (#464).
 *
 * Default path — ASSERT byte-equality and throw on any mismatch, so a committed
 * golden going stale fails the gate loudly instead of rotting undetected. The
 * old behaviour wrote the goldens on every run and walked away: the artifact
 * built to turn output changes into a reviewable diff was itself drifting
 * silently (e.g. `6d368e7` reclassified five analyzer scripts, shifting `sync`'s
 * summary, but never re-goldened `05-sync.txt` — the stale golden survived every
 * test run until a human happened to notice the dirty file).
 *
 * Escape hatch — `UPDATE_GOLDENS=1` skips the assertion and PERSISTS the new
 * bytes. This is the deliberate re-golden path: output changed on purpose? run
 * with `UPDATE_GOLDENS=1` and commit the diff (see tests/e2e/golden/README.md).
 */
async function reconcileGoldens(steps: CapturedStep[], goldenDir: string): Promise<void> {
  if (process.env.UPDATE_GOLDENS === "1") {
    const written = await writeGoldenOutput(steps, goldenDir);
    // eslint-disable-next-line no-console
    console.warn(
      `[friction-gate] UPDATE_GOLDENS=1 — wrote ${written.length} golden file(s); ` +
        `review and commit the diff.`,
    );
    return;
  }
  const mismatches = await assertGoldenOutput(steps, goldenDir);
  if (mismatches.length === 0) return;
  const detail = mismatches
    .map((m) => `  ${m.file} (${m.reason}):\n${m.diff}`)
    .join("\n");
  throw new Error(
    `[friction-gate] committed golden output is stale — ${mismatches.length} file(s) no ` +
      `longer match the CLI's rendered output (-committed / +produced):\n${detail}\n\n` +
      `If the output changed on purpose, re-run with UPDATE_GOLDENS=1 and commit the diff ` +
      `(see tests/e2e/golden/README.md).`,
  );
}

/**
 * Capture one command on its OWN fresh copy of the snapshot — for surfaces the
 * shared post-adopt tree can't represent (a pre-adopt `greet`, a greenfield
 * `init`, a `git`-seeded `migrate-layout`). The returned step carries its
 * `workDir`, so `buildNextStepRunner` runs its `→ Next:` suggestions against
 * this tree, not the main one.
 */
async function captureFreshCopy(
  opts: RunFrictionGateOpts,
  name: string,
  args: string[],
  setup: { adopt: boolean; git?: boolean },
): Promise<CapturedStep> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pack = opts.pack ?? "next-react";
  const tree = await mkdtemp(join(tmpdir(), `e2e-friction-${name}-`));
  await cp(opts.fixtureDir, tree, { recursive: true });
  if (setup.git) {
    git(tree, ["init", "-q"]);
    // Commit the snapshot BEFORE adopt: adopt's clean-tree guard refuses on a
    // tree full of untracked files, so the seed commit makes the tree clean and
    // gives a later `git mv` (migrate-layout) a tracked base.
    gitCommitAll(tree, "seed snapshot");
  }
  if (setup.adopt) {
    const setupAdopt = await runStep("setup-adopt", [opts.cliPath, "adopt", "--pack", pack, "--yes"], tree, timeoutMs);
    if (setupAdopt.exitCode !== 0) {
      throw new Error(
        `friction-gate: setup adopt for "${name}" failed (exit ${setupAdopt.exitCode}). ` +
          `The captured step would grade a non-adopted tree.\n${setupAdopt.combined}`,
      );
    }
    if (setup.git) gitCommitAll(tree, "adopt");
  }
  return runStep(name, args, tree, timeoutMs);
}

/** Run a git subcommand in `dir`, swallowing output (seeds the migrate-layout tree). */
function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
}

/** Stage and commit everything in `dir` with a fixed identity (no global git config needed). */
function gitCommitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, [
    "-c", "user.email=gate@claude-ds.local",
    "-c", "user.name=friction-gate",
    "commit", "-q", "-m", message,
  ]);
}

/**
 * Build the next-step runner the `next-step-dead-end` rule needs. It executes
 * every `→ Next:` suggestion against a fresh copy of the post-run tree and
 * reports liveness (did state change?) and refusal. A suggestion that is not a
 * directly-runnable `claude-ds` command as written (prose, a `<placeholder>`,
 * or a bare shell hint) is `refused` — structurally a dead end the consumer
 * cannot act on without editing it (PRD #439 user story 9).
 *
 * `scanFriction`'s runner contract is synchronous, but running a subprocess is
 * async, so we PRE-EXECUTE every parsed suggestion here and hand back a sync
 * lookup over the precomputed results.
 */
export async function buildNextStepRunner(
  steps: CapturedStep[],
  postRunTree: string,
  cliPath: string,
  timeoutMs: number,
): Promise<(command: string) => NextStepRunResult> {
  const cache = new Map<string, NextStepRunResult>();

  // Per step, run that step's suggestions against the tree the step ran on
  // (`step.workDir`) — falling back to the shared post-run tree for steps that
  // didn't record one. This keeps a `→ Next:` printed by an alternate-tree step
  // (a greenfield `init`, a git-seeded `migrate-layout`) honest: liveness is
  // judged against the same state the user would be in, not the main tree's.
  for (const step of steps) {
    const tree = step.workDir ?? postRunTree;
    for (const cmd of parseNextSteps(step.combined)) {
      if (cache.has(cmd)) continue;
      const args = extractClaudeDsArgs(cmd, cliPath);
      if (!args) {
        cache.set(cmd, {
          refused: true,
          changedState: false,
          note: "not a directly-runnable claude-ds command as written",
        });
        continue;
      }
      const scratch = await mkdtemp(join(tmpdir(), "e2e-friction-next-"));
      await cp(tree, scratch, { recursive: true });
      const before = await fingerprint(scratch);
      const r = await runStep("next", args, scratch, timeoutMs);
      const after = await fingerprint(scratch);
      const refused =
        r.exitCode !== 0 ||
        /\b(refus|abort|won't|cannot|will not|dirty)\b/i.test(r.combined);
      cache.set(cmd, {
        refused,
        changedState: before !== after,
        note: `exit ${r.exitCode}`,
      });
    }
  }

  return (command: string): NextStepRunResult =>
    cache.get(command) ?? {
      refused: true,
      changedState: false,
      note: "suggestion was not parsed from output",
    };
}

/**
 * The full gate: capture the run, scan with a real runner injected, reconcile
 * against the baseline. The caller (the vitest spec) asserts `pass` and surfaces
 * `regressions` / `stale` in the failure message.
 */
export async function runFrictionGate(
  opts: RunFrictionGateOpts,
  baseline: FrictionBaseline,
): Promise<RatchetResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const { steps, workDir } = await captureFrictionRun(opts);
  const runner = await buildNextStepRunner(steps, workDir, opts.cliPath, timeoutMs);

  // Scan PER TREE, not over the flat list. The per-step rules (repetition,
  // jargon, next-step) don't care, but the cross-run rules (self-contradiction,
  // self-block) assume a single run on a single tree — feeding them an
  // alternate-tree capture (a pre-adopt `greet` whose tree has no
  // `.claude-ds.json`, scanned alongside the config-present main tree) would
  // manufacture a phantom "missing vs present" contradiction. Grouping by the
  // tree each step ran on keeps those rules honest; findings are merged and
  // deduped by key. Steps with no `workDir` (the interactive PTY capture) ran on
  // the main tree, so they group with it.
  const groups = new Map<string, CapturedStep[]>();
  for (const s of steps) {
    const key = s.workDir ?? workDir;
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  const findings: FrictionFinding[] = [];
  const seen = new Set<string>();
  for (const group of groups.values()) {
    for (const f of scanFriction(group, { runner })) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      findings.push(f);
    }
  }
  return reconcile(findings, baseline);
}

// ----------------------------------------------------------------------------
// internals
// ----------------------------------------------------------------------------

interface RawStep extends CapturedStep {
  durationMs: number;
}

/**
 * Write {@link BROWNFIELD_ATOM_COUNT} atoms whose `meta` declares no `kind` into
 * the scratch copy's `design-system/atoms/`. heal's `audit --fix` injects
 * `meta.kind` into each, emitting one near-identical
 * `fixed [DRIFT-META-KIND-MISSING]: …` line per file — the wall of repetition a
 * real brownfield adopter hits (PRD #439). The count is above the detector's
 * threshold so the `repetition` rule fires.
 *
 * Names are zero-padded so the fixer's alphabetical ordering is stable across
 * runs (the golden's line order is deterministic). The shape mirrors the
 * fixture's own kind-less `IconLabel.tsx`: a valid component plus an `as const`
 * meta with `kind` absent and no `: Meta` annotation (which would refuse to
 * compile without `kind`).
 */
async function injectBrownfieldSurface(work: string): Promise<void> {
  const atomsDir = join(work, "design-system", "atoms");
  await mkdir(atomsDir, { recursive: true });
  for (let i = 1; i <= BROWNFIELD_ATOM_COUNT; i++) {
    const name = `Unclassified${String(i).padStart(2, "0")}`;
    await writeFile(join(atomsDir, `${name}.tsx`), kindlessAtomSource(name), "utf8");
  }
}

/** Source for one injected kind-less atom (see {@link injectBrownfieldSurface}). */
function kindlessAtomSource(name: string): string {
  return (
    [
      `// Injected at runtime by the friction gate (PRD #443): an atom whose meta`,
      `// has NO \`kind\`. heal's fixer adds it, producing one line in the wall of`,
      `// near-identical "fixed [DRIFT-META-KIND-MISSING]" output the repetition`,
      `// rule grades. NOT committed — kept out of the shared snapshot fixture.`,
      `export function ${name}(props: { text?: string }) {`,
      `  return <span>{props.text ?? ""}</span>;`,
      `}`,
      ``,
      `export const meta = {`,
      `  examples: [{ name: "default", props: { text: "" } }],`,
      `} as const;`,
    ].join("\n") + "\n"
  );
}

/**
 * Extract a runnable `claude-ds <subcommand> [flags]` argv from a suggestion,
 * rooted at the built CLI so the runner drives the SAME binary the gate does.
 * Returns null when the suggestion is not directly runnable: it doesn't name a
 * claude-ds subcommand, or it carries a `<placeholder>` the user must fill in.
 */
function extractClaudeDsArgs(suggestion: string, cliPath: string): string[] | null {
  const m = suggestion.match(/claude-ds\s+([a-z][a-z-]*(?:\s+--?[\w-]+(?:\s+[^\s'"]+)?)*)/i);
  if (!m) return null;
  const tokens = m[1].split(/\s+/).filter(Boolean);
  if (tokens.some((t) => /[<>]/.test(t))) return null; // unresolved placeholder
  return [cliPath, ...tokens];
}

/** Spawn the CLI/cmd, capture stdout+stderr, force non-TTY/no-color. */
function runStep(
  name: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<RawStep> {
  const start = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n[friction-gate] step '${name}' timed out after ${timeoutMs}ms`;
    }, timeoutMs);
    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Rewrite the scratch cwd → `<project>` so a command that echoes absolute
      // paths (e.g. reconform's planned-file list) still goldens reproducibly.
      // A no-op for the commands that never print their cwd.
      const out = normalizeScratchPath(stdout, cwd);
      const err = normalizeScratchPath(stderr, cwd);
      resolvePromise({
        name,
        command: `node ${args.join(" ")}`,
        exitCode,
        durationMs: Date.now() - start,
        stdout: out,
        stderr: err,
        combined: out + err,
        workDir: cwd,
      });
    };
    child.on("error", (err) => {
      stderr += `\n[friction-gate] spawn error: ${err.message}`;
      settle(127);
    });
    child.on("close", (code, signal) => settle(code ?? (signal ? 124 : 1)));
  });
}

/**
 * Fingerprint a tree (sorted path:size:mtime) so the runner can tell whether a
 * suggested next step changed any state. node_modules / .git are skipped.
 */
async function fingerprint(dir: string): Promise<string> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let ents;
    try {
      ents = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const s = await stat(p);
        out.push(`${p}:${s.size}:${s.mtimeMs}`);
      }
    }
  }
  await walk(dir);
  return out.sort().join("\n");
}

/** Read and parse the committed baseline file. */
export async function readBaseline(path: string): Promise<FrictionBaseline> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as { keys?: unknown; _removal_triggers?: unknown };
  if (!parsed || !Array.isArray(parsed.keys)) {
    throw new Error(`friction-gate: malformed baseline at ${path} — expected { keys: string[] }`);
  }
  const removalTriggers =
    parsed._removal_triggers && typeof parsed._removal_triggers === "object"
      ? (parsed._removal_triggers as Record<string, string>)
      : {};
  return { keys: parsed.keys as string[], removalTriggers };
}
