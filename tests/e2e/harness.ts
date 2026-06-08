/**
 * Headless end-to-end harness — drives the **real built CLI** against a
 * Crewops-shaped consumer fixture and produces a structured deviation report
 * (the one-time discovery catalogue for parent PRD #407).
 *
 * Headless contract — the harness never asserts against rendered TTY. It
 * observes only:
 *   - subprocess exit codes
 *   - parsed `--json` payloads where the CLI emits them
 *   - on-disk state of the fixture copy after each step
 *   - the consumer's own `tsc --noEmit` exit + parsed error stream
 *
 * That is exactly what a verifying agent that *cannot see TTY output* can
 * also observe (PRD user stories #25 / #26): the bytes that drive the gate
 * are the same bytes the agent reads back.
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
    return finalize();
  }

  if (!existsSync(join(opts.workDir, ".claude-ds.json"))) {
    deviations.push({
      category: "missing-config",
      detail: "adopt exited 0 but did not write .claude-ds.json",
    });
    return finalize();
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

  return finalize();

  function finalize(): HarnessReport {
    return {
      fixture: fixtureName,
      pass: deviations.length === 0,
      steps,
      deviations,
      tsc,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
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
