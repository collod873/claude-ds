/**
 * PRD #439 — friction gate + baseline ratchet (the closing edge of the loop).
 *
 * Drives the **real built CLI** through the real command sequence
 * (`adopt → heal → audit --fix → doctor → classify → sync → reconcile →
 * upgrade → version → enforce → front door`, plus an interactive PTY front-door
 * capture) against a copy of the harvested `crewops-snapshot` fixture, captures
 * the rendered stdout/stderr of each step,
 * runs `scanFriction` over it (with a real next-step runner injected), and
 * reconciles the resulting findings against a committed `friction-baseline`.
 *
 * The ratchet (PRD #439 user story 14):
 *   - Any finding whose stable `key` is NOT in the baseline is a REGRESSION and
 *     fails the gate. New friction ⇒ fail.
 *   - Baseline keys may only be REMOVED across commits, never added. The gate
 *     never auto-writes the baseline; closing a friction issue means hand-
 *     deleting its key (see docs/agents/friction-loop.md) and the gate refusing
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
import { spawn } from "node:child_process";
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
import { writeGoldenOutput, captureInteractive } from "./harness.js";

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
  // Deliberately NOT graded here, each for a CONCRETE blocker (NOT silently
  // dropped — see PRD #439 "no silent caps"):
  //   reconform           — its output echoes the ABSOLUTE scratch path of each
  //                         planned file, so the golden is not reproducible across
  //                         machines until the gate normalizes the scratch cwd in
  //                         the piped body (the PTY golden already does this via
  //                         normalizePtyCapture; the runStep goldens do not yet).
  //   migrate / migrate-layout — do `git mv`, so they need a real git repo seeded
  //                         in the scratch tree (and migrate needs a <path> arg).
  //   init                — greenfield BLOCK-mode full scaffold; conflicts with the
  //                         already-adopted tree, so it needs its own fresh copy.
  // Each is a known follow-up: add it here once its blocker above is cleared.
  steps.push(await runStep("doctor", [opts.cliPath, "doctor"], work, timeoutMs));
  steps.push(await runStep("classify", [opts.cliPath, "classify", "--dry-run"], work, timeoutMs));
  steps.push(await runStep("sync", [opts.cliPath, "sync", "--dry-run"], work, timeoutMs));
  steps.push(await runStep("reconcile", [opts.cliPath, "reconcile", "--dry-run"], work, timeoutMs));
  steps.push(await runStep("upgrade", [opts.cliPath, "upgrade", "--dry-run"], work, timeoutMs));
  steps.push(await runStep("version", [opts.cliPath, "version", "--offline"], work, timeoutMs));
  steps.push(await runStep("enforce", [opts.cliPath, "enforce"], work, timeoutMs));

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
    await writeGoldenOutput(steps, opts.goldenDir);
  }

  return { steps, workDir: work };
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
  const allText = steps.map((s) => s.combined).join("\n");
  const cache = new Map<string, NextStepRunResult>();

  for (const cmd of parseNextSteps(allText)) {
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
    await cp(postRunTree, scratch, { recursive: true });
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
  const findings = scanFriction(steps, { runner });
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
      resolvePromise({
        name,
        command: `node ${args.join(" ")}`,
        exitCode,
        durationMs: Date.now() - start,
        stdout,
        stderr,
        combined: stdout + stderr,
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
  const parsed = JSON.parse(raw) as Partial<FrictionBaseline>;
  if (!parsed || !Array.isArray(parsed.keys)) {
    throw new Error(`friction-gate: malformed baseline at ${path} — expected { keys: string[] }`);
  }
  return { keys: parsed.keys };
}
