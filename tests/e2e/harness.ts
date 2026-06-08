/**
 * Headless end-to-end harness — drives the **real built CLI** against a
 * Crewops-shaped consumer fixture and produces a structured deviation report
 * (the one-time discovery catalogue for parent PRD #407).
 *
 * Headless contract — the bytes this harness captures and asserts on are the
 * SAME bytes a TTY-blind agent reads back from stdout/stderr. The harness
 * observes:
 *   - subprocess exit codes
 *   - parsed `--json` payloads where the CLI emits them
 *   - on-disk state of the fixture copy after each step
 *   - the consumer's own `tsc --noEmit` exit + parsed error stream
 *   - the **rendered stdout/stderr** of each command step (gate mode)
 *
 * Rendered output as a first-class artifact (PRD #439) — the harness's
 * original stance ("never assert against rendered TTY") optimized for what a
 * TTY-blind agent can see, but had the side effect of making the friction
 * layer untestable, because 100% of the graded friction lives in the
 * human-rendered terminal output. That self-imposed ban is now lifted: in
 * GATE MODE the captured rendered text is written to a golden file (a
 * reviewable-diff artifact) and exposed to the friction-detector module. The
 * contract is intact — the capture comes from the SAME built CLI a user runs
 * (no test-only rendering path), and the bytes goldened are byte-for-byte the
 * bytes a blind agent reads, which are byte-for-byte the bytes a user sees.
 *
 * Discovery-first: every check that fails appends one entry to
 * `report.deviations` — the run does NOT throw on first failure. That makes
 * the report the authoritative enumeration of every current break against a
 * real consumer in a single pass, rather than dripping them out one release
 * at a time.
 */
import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

/** One CLI / tsc subprocess invocation the harness recorded. */
export interface StepResult {
  /** Logical step name (`adopt`, `heal`, `tsc`). */
  name: string;
  /** Argv as a single human-readable string — useful in a failing report. */
  command: string;
  exitCode: number;
  /** Wall-clock ms, rounded. Helps spot the step that hung. */
  durationMs: number;
  stdout: string;
  stderr: string;
  /** Parsed `--json` payload when the step ran with `--json` and emitted one. */
  json?: unknown;
}

/**
 * Rendered output of one command step, exposed for downstream consumers —
 * principally the friction-detector module (PRD #439), which scans the human
 * terminal output for the graded friction patterns (self-contradiction, walls
 * of repeated lines, dishonest convergence, dead-end next-steps, untranslated
 * jargon, self-block).
 *
 * INTERFACE NOTE for the friction-detector agent: import this type from the
 * harness rather than re-declaring it. `runE2eHarness` returns
 * `report.captured: CapturedStep[]` (one per command step, in run order; the
 * `tsc` verify step is included). Feed `stdout`/`stderr`/`combined` to
 * `scanFriction(captured, context)`. The bytes here are the exact bytes a
 * TTY-blind agent — and a real user — reads from the built CLI.
 */
export interface CapturedStep {
  /** Logical step name (`adopt`, `heal`, `tsc`) — stable key for matching. */
  name: string;
  /** Argv as a single human-readable string. */
  command: string;
  exitCode: number;
  /** Captured stdout bytes, decoded utf8 — verbatim from the built CLI. */
  stdout: string;
  /** Captured stderr bytes, decoded utf8 — verbatim from the built CLI. */
  stderr: string;
  /**
   * stdout + stderr concatenated in stream order is NOT reconstructable from
   * separate buffers, so this is `stdout` then `stderr` — the conventional
   * "what scrolled past" view for friction scans that don't care which stream
   * a line came from. Detectors that need stream provenance read the fields
   * above.
   */
  combined: string;
}

/** Parsed entry from `tsc --noEmit` output. */
export interface TsError {
  file: string;
  line: number;
  col: number;
  /** TS error code like `TS2304`. */
  code: string;
  message: string;
}

/** Aggregated result of running the consumer's own `tsc --noEmit`. */
export interface TscResult {
  exitCode: number;
  errorCount: number;
  errors: TsError[];
}

/**
 * One observed deviation from the green end-state. The `category` is the
 * stable machine key; future fix PRs reference it. `detail` is a one-line
 * human description; `evidence` carries the smoking gun (line of stdout, the
 * duplicate decl text, etc.) so the catalogue is debuggable on its own.
 */
export interface Deviation {
  category:
    | "adopt-failed"
    | "heal-failed"
    | "missing-managed-file"
    | "missing-config"
    | "duplicate-meta-decl"
    | "consumer-tsc-error"
    | "consumer-tsc-failed";
  detail: string;
  file?: string;
  evidence?: string;
}

/** Full machine-readable harness output. */
export interface HarnessReport {
  /** Fixture name (basename of `fixtureDir`). */
  fixture: string;
  /**
   * Overall pass = no deviations were recorded. `true` is the target green
   * end-state; today's CI gate treats this as informational (the harness is
   * non-blocking until the PRD's fix list lands).
   */
  pass: boolean;
  /** Each subprocess the harness ran, in order. */
  steps: StepResult[];
  /**
   * Rendered stdout/stderr of each command step, in run order — the
   * first-class verification artifact the friction-detector module consumes
   * (PRD #439). Always populated (it is a projection of `steps`); gate mode
   * additionally goldens it to disk via `writeGoldenOutput`.
   */
  captured: CapturedStep[];
  /** Every observed gap from green, in the order they were detected. */
  deviations: Deviation[];
  /** Set when `tsc` ran; absent when an earlier step prevented it. */
  tsc?: TscResult;
  /** ISO-8601 wall-clock start time of the run. */
  startedAt: string;
  /** ISO-8601 wall-clock end time of the run. */
  finishedAt: string;
}

export interface HarnessOpts {
  /** Absolute path to the source fixture directory (copied, never mutated). */
  fixtureDir: string;
  /** Absolute path to the built CLI entry — typically `<repo>/dist/cli.js`. */
  cliPath: string;
  /**
   * Absolute path to the `tsc` binary used for the consumer's verify step.
   * Defaults to `<repo>/node_modules/typescript/bin/tsc`, located by walking
   * up from `cliPath`'s directory. Configurable so tests can stub it.
   */
  tscPath?: string;
  /**
   * Destination directory the fixture is copied into. Caller owns its
   * lifecycle (typically `freshTmpDir` / `cleanup`). Created if absent.
   */
  workDir: string;
  /**
   * Optional pack name passed to `adopt --pack`. Defaults to `next-react`,
   * the only pack today.
   */
  pack?: string;
  /**
   * Subprocess timeout per step. Default 60_000 ms — generous for `tsc` over
   * a fully scaffolded fixture while still bounded for CI. A step that times
   * out becomes a deviation with exit code `124` (POSIX timeout convention).
   */
  timeoutMs?: number;
  /**
   * Gate mode (PRD #439). When set, the harness writes each command step's
   * rendered stdout/stderr to a golden file under `goldenDir` after the run,
   * so any unintended change to user-facing output surfaces as a reviewable
   * diff rather than silent drift. The captured text is ALSO always exposed
   * on `report.captured` regardless of this option — `goldenDir` only governs
   * whether it is persisted as golden files. Absent ⇒ no golden files written
   * (the legacy discovery-catalogue behaviour).
   */
  goldenDir?: string;
}

/**
 * Run the full smoke chain — `adopt → heal → tsc` — against a copy of
 * `fixtureDir` rooted at `workDir`, and return the structured report.
 *
 * Never throws on a CLI / tsc non-zero exit; surfaces every gap as a
 * `Deviation` so callers (CI, unit tests) read the report rather than the
 * exception. Only environmental failures (missing CLI, missing tsc, work
 * dir unmkdir-able) reject — those are operator errors, not deviations.
 */
export async function runE2eHarness(opts: HarnessOpts): Promise<HarnessReport> {
  const pack = opts.pack ?? "next-react";
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const tscPath = opts.tscPath ?? defaultTscPath(opts.cliPath);
  const startedAt = new Date().toISOString();

  if (!existsSync(opts.cliPath)) {
    throw new Error(`harness: CLI not built — ${opts.cliPath} does not exist (run \`npm run build\`)`);
  }
  if (!existsSync(tscPath)) {
    throw new Error(`harness: tsc not found at ${tscPath}`);
  }
  if (!existsSync(opts.fixtureDir)) {
    throw new Error(`harness: fixture missing at ${opts.fixtureDir}`);
  }

  await mkdir(opts.workDir, { recursive: true });
  await cp(opts.fixtureDir, opts.workDir, { recursive: true });

  const fixtureName = basename(opts.fixtureDir);
  const steps: StepResult[] = [];
  const deviations: Deviation[] = [];
  let tsc: TscResult | undefined;

  // ── adopt ────────────────────────────────────────────────────────────
  const adopt = await runStep({
    name: "adopt",
    cmd: process.execPath,
    args: [opts.cliPath, "adopt", "--pack", pack, "--yes"],
    cwd: opts.workDir,
    timeoutMs,
  });
  steps.push(adopt);
  if (adopt.exitCode !== 0) {
    deviations.push({
      category: "adopt-failed",
      detail: `adopt exited ${adopt.exitCode} on a fresh Crewops-shaped fixture`,
      evidence: lastLines(adopt.stderr || adopt.stdout, 6),
    });
    // adopt failure → skip downstream; the report still finishes.
    return await finalize();
  }

  if (!existsSync(join(opts.workDir, ".claude-ds.json"))) {
    deviations.push({
      category: "missing-config",
      detail: "adopt exited 0 but did not write .claude-ds.json",
    });
    return await finalize();
  }

  // ── heal ─────────────────────────────────────────────────────────────
  // HEAL_EXIT_PENDING (3) is "needs Collin" rather than a hard failure —
  // surface it as a deviation but continue so tsc still runs on the
  // partial-fixed-point tree. Exit 1 = did-not-converge.
  const heal = await runStep({
    name: "heal",
    cmd: process.execPath,
    args: [opts.cliPath, "heal"],
    cwd: opts.workDir,
    timeoutMs,
  });
  steps.push(heal);
  if (heal.exitCode === 1) {
    deviations.push({
      category: "heal-failed",
      detail: `heal did not converge (exit 1) on a Crewops-shaped fixture`,
      evidence: lastLines(heal.stderr || heal.stdout, 6),
    });
  } else if (heal.exitCode === 3) {
    deviations.push({
      category: "heal-failed",
      detail: `heal exited HEAL_EXIT_PENDING (3) — automatable settled but ambiguities remain`,
      evidence: lastLines(heal.stderr || heal.stdout, 6),
    });
  } else if (heal.exitCode !== 0) {
    deviations.push({
      category: "heal-failed",
      detail: `heal exited ${heal.exitCode}`,
      evidence: lastLines(heal.stderr || heal.stdout, 6),
    });
  }

  // ── filesystem assertions ────────────────────────────────────────────
  for (const f of REQUIRED_MANAGED_FILES) {
    if (!existsSync(join(opts.workDir, f))) {
      deviations.push({
        category: "missing-managed-file",
        detail: `managed pack file missing after heal: ${f}`,
        file: f,
      });
    }
  }

  // ── duplicate `export const meta` scan ───────────────────────────────
  // A1 (PRD #407): the broken meta-kind-missing fixer appends a second
  // `export const meta = {…}` to files that already declare one. We grep
  // the post-heal tree directly so the catalogue names the offending files
  // even when tsc's TS2300 message buries them in a longer chain.
  for (const file of await listTsxFiles(join(opts.workDir, "design-system"))) {
    const text = await readFile(file, "utf8");
    const matches = text.match(/^export\s+const\s+meta\b/gm) ?? [];
    if (matches.length > 1) {
      deviations.push({
        category: "duplicate-meta-decl",
        detail: `${matches.length} \`export const meta\` declarations in one file`,
        file: relative(opts.workDir, file),
        evidence: matches.join(" / "),
      });
    }
  }

  // ── consumer tsc ─────────────────────────────────────────────────────
  const tscStep = await runStep({
    name: "tsc",
    cmd: process.execPath,
    args: [tscPath, "--noEmit", "-p", "."],
    cwd: opts.workDir,
    timeoutMs,
  });
  steps.push(tscStep);
  tsc = parseTscOutput(tscStep.stdout + tscStep.stderr, tscStep.exitCode);
  if (tscStep.exitCode !== 0) {
    deviations.push({
      category: "consumer-tsc-failed",
      detail: `consumer tsc --noEmit exited ${tscStep.exitCode} with ${tsc.errorCount} error(s)`,
    });
    for (const e of tsc.errors) {
      deviations.push({
        category: "consumer-tsc-error",
        detail: `${e.code} ${e.message}`,
        file: e.file,
        evidence: `${e.file}:${e.line}:${e.col}`,
      });
    }
  }

  return await finalize();

  async function finalize(): Promise<HarnessReport> {
    const captured: CapturedStep[] = steps.map(toCapturedStep);
    const report: HarnessReport = {
      fixture: fixtureName,
      pass: deviations.length === 0,
      steps,
      captured,
      deviations,
      tsc,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    // Gate mode: persist the rendered output as golden files so any
    // unintended change to user-facing output is a reviewable diff. This is
    // the ONLY place rendered output touches disk; the captured text is on
    // the report regardless, for the friction-detector module to consume.
    if (opts.goldenDir) {
      await writeGoldenOutput(captured, opts.goldenDir);
    }
    return report;
  }
}

/** Project a recorded `StepResult` to the consumer-facing `CapturedStep`. */
function toCapturedStep(s: StepResult): CapturedStep {
  return {
    name: s.name,
    command: s.command,
    exitCode: s.exitCode,
    stdout: s.stdout,
    stderr: s.stderr,
    combined: s.stdout + s.stderr,
  };
}

/** Files the harness expects to exist after `adopt → heal`. */
const REQUIRED_MANAGED_FILES = [
  ".claude-ds.json",
  "design-system/types/meta.ts",
  "design-system/contracts/runner.ts",
  "design-system/contracts/roles/index.ts",
  "design-system/contracts/roles/types.ts",
  "design-system/contracts/roles/combobox.ts",
  "design-system/manifest.json",
];

interface RunStepOpts {
  name: string;
  cmd: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

/**
 * Spawn a subprocess, capture stdout/stderr, surface the exit code. Never
 * inherits stdio — every observation flows through the captured streams so
 * the report is reproducible from the bytes alone.
 */
async function runStep(opts: RunStepOpts): Promise<StepResult> {
  const start = Date.now();
  const command = `${basename(opts.cmd)} ${opts.args.map(quoteIfNeeded).join(" ")}`;
  return new Promise((resolvePromise) => {
    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Force non-TTY so the CLI takes its agent-shaped path — the harness's
      // whole point is asserting against the byte stream a non-TTY consumer
      // sees, not the colorized TTY render.
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n[harness] step '${opts.name}' timed out after ${opts.timeoutMs}ms`;
    }, opts.timeoutMs);

    // Node fires `error` then `close` on spawn failure; guard so the second
    // event doesn't replace the diagnostic-rich result from the first.
    const settle = (result: StepResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    child.on("error", (err) => {
      settle({
        name: opts.name,
        command,
        exitCode: 127,
        durationMs: Date.now() - start,
        stdout,
        stderr: stderr + `\n[harness] spawn error: ${err.message}`,
      });
    });
    child.on("close", (code, signal) => {
      const exit = code ?? (signal ? 124 : 1);
      settle({
        name: opts.name,
        command,
        exitCode: exit,
        durationMs: Date.now() - start,
        stdout,
        stderr,
        json: opts.args.includes("--json") ? tryParseJson(stdout) : undefined,
      });
    });
  });
}

/**
 * Parse `tsc --noEmit` diagnostics. tsc emits lines like
 *   `path/to/file.ts(12,7): error TS2304: Cannot find name 'Foo'.`
 * on stdout (or stderr depending on terminal). We accept either stream.
 */
export function parseTscOutput(raw: string, exitCode: number): TscResult {
  const errors: TsError[] = [];
  const re = /^([^()\n]+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    errors.push({
      file: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
      code: m[4],
      message: m[5].trim(),
    });
  }
  return { exitCode, errorCount: errors.length, errors };
}

function defaultTscPath(cliPath: string): string {
  // cliPath = <repo>/dist/cli.js → walk up to <repo> and dive into node_modules.
  const repoRoot = resolve(dirname(cliPath), "..");
  return join(repoRoot, "node_modules", "typescript", "bin", "tsc");
}

function lastLines(s: string, n: number): string {
  const lines = s.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.slice(-n).join("\n");
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function quoteIfNeeded(arg: string): string {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

async function listTsxFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    if (!existsSync(d)) return;
    const ents = await readdir(d, { withFileTypes: true });
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && /\.tsx?$/.test(e.name) && !e.name.endsWith(".showcase.tsx")) {
        out.push(p);
      }
    }
  }
  await walk(dir);
  return out;
}

/**
 * Convenience: write the report to a file as canonical JSON. CI uploads the
 * result as an artifact so the discovery catalogue is browsable from the run
 * summary page without re-running the harness locally.
 */
export async function writeReport(report: HarnessReport, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", "utf8");
}

/**
 * Write the captured rendered output of each step to golden files under
 * `goldenDir` (PRD #439, user story #20). One file per step
 * (`<NN>-<name>.txt`), zero-padded and ordered so the directory listing reads
 * in run order. Each file holds the EXACT bytes the built CLI emitted to
 * stdout then stderr — the same bytes a user and a TTY-blind agent see — so a
 * change to user-facing output shows up as a reviewable diff under version
 * control rather than silent drift.
 *
 * Determinism note: callers that golden these into the repo must run the CLI
 * with stable env (`FORCE_COLOR=0`, `NO_COLOR=1`, `CI=1` — already forced by
 * `runStep`) and against a committed snapshot, so the bytes are reproducible.
 * These goldens are COMMITTED (the reviewable-diff baseline, US20), so the
 * header must carry NO machine-specific bytes. The provenance `# command:` line
 * records the invocation as the built CLI saw it, EXCEPT the absolute path to
 * the binary (`<home>/.../dist/cli.js`, `<repo>/node_modules/.bin/tsc`) is
 * rewritten to a stable repo-relative token via `normalizeCommand` — otherwise
 * a benign copy change would never surface in a PR diff because every machine's
 * absolute path would dirty the file first. The captured stdout/stderr BODY is
 * left untouched (verbatim CLI bytes); the CLI runs in a scratch `cwd` and does
 * not echo absolute paths, so the body is already machine-independent.
 *
 * Returns the absolute paths written, in step order, so a gate can diff them.
 */
export async function writeGoldenOutput(
  captured: CapturedStep[],
  goldenDir: string,
): Promise<string[]> {
  await mkdir(goldenDir, { recursive: true });
  const written: string[] = [];
  let i = 0;
  for (const step of captured) {
    const idx = String(i).padStart(2, "0");
    const safeName = step.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const path = join(goldenDir, `${idx}-${safeName}.txt`);
    // Header records provenance (command + exit) above a clear delimiter so a
    // reviewer reads what produced these bytes without consulting the report.
    const body =
      `# command: ${normalizeCommand(step.command)}\n` +
      `# exit: ${step.exitCode}\n` +
      `# --- stdout/stderr below; bytes are verbatim from the built CLI ---\n` +
      step.combined;
    await writeFile(path, body, "utf8");
    written.push(path);
    i += 1;
  }
  return written;
}

/**
 * Strip machine-specific absolute prefixes from a recorded `# command:` line so
 * the committed golden is byte-identical across machines. The harness invokes
 * `node <abs>/dist/cli.js …` and `node <abs>/node_modules/.bin/tsc …`; we
 * rewrite each absolute path argument to start at its repo-relative marker
 * (`dist/…` or `node_modules/…`), collapsing the leading home/tmp/repo prefix.
 * Anything not matching a known marker is left as-is — this is a targeted
 * de-machine-ification, not a general path scrubber, so a future absolute
 * argument would still be visible (and caught) in review.
 */
export function normalizeCommand(command: string): string {
  // The prefix matcher allows spaces (e.g. a "Claude Projects" home dir) — it
  // starts at an absolute-path `/` and lazily consumes up to the first
  // `dist/`|`node_modules/` marker, then keeps the repo-relative tail verbatim.
  return command.replace(
    /(^|\s)\/.*?\/((?:dist|node_modules)\/\S+)/g,
    "$1$2",
  );
}
