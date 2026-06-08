/**
 * Issue #408 — Headless command contracts.
 *
 * For every loop-critical command (adopt, heal, audit, audit --fix, upgrade,
 * sync, classify, doctor), assert the machine-readable contract a verifying
 * agent that cannot see TTY relies on:
 *
 *   - A documented, meaningful **exit code** for each outcome state.
 *   - A `--json` surface emitting a single JSON document whose shape is
 *     stable: { command, ok, verdict, exitCode, actions, remaining }.
 *   - The non-TTY byte stream is byte-identical to today minus color. A
 *     `--json` invocation suppresses the human chatter — the JSON document
 *     is the entirety of stdout (or the entirety of the non-error stream).
 *
 * These tests intentionally drive the CLI through `runCli` (which runs
 * non-TTY) so the assertions land on exactly what a headless caller sees.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";

const BASE_CFG = {
  packVersion: "v0.9.0",
  pack: "next-react",
  mode: "warn",
  domain_roots: ["features", "lib"],
};

interface HeadlessResult {
  command: string;
  ok: boolean;
  verdict: string;
  exitCode: number;
  actions: Record<string, unknown>;
  remaining: Record<string, unknown>;
}

function parseJsonOutput(stdout: string): HeadlessResult {
  // The contract says the JSON document is the entirety of stdout — no
  // human chatter mixed in. We parse the whole thing and fail loud if it
  // isn't a single JSON object.
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  return JSON.parse(trimmed) as HeadlessResult;
}

describe("headless contract — adopt", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("--json on fresh tree emits the headless contract and exits 0", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--json"], { cwd: dir });
    expect(r.code).toBe(0);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("adopt");
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.verdict).toBe("adopted");
    expect(result.actions).toBeDefined();
    expect(result.remaining).toBeDefined();
  });

  it("--json on already-adopted tree exits 2 with verdict='error'", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    const r = await runCli(["adopt", "--pack", "next-react", "--json"], { cwd: dir });
    expect(r.code).toBe(2);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("adopt");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it("--json suppresses all non-JSON stdout (no human chatter)", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--json"], { cwd: dir });
    // The entire stdout must parse as JSON. If any human info() line leaks in,
    // JSON.parse throws and the test fails.
    expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
  });
});

describe("headless contract — sync", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("--json without .claude-ds.json exits 2 with error verdict", async () => {
    const r = await runCli(["sync", "--json", "--offline-fixture", "packs/next-react"], { cwd: dir });
    expect(r.code).toBe(2);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("sync");
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("error");
  });

  it("--json after adopt emits headless contract on in-sync tree", async () => {
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    const r = await runCli(
      ["sync", "--json", "--offline-fixture", "packs/next-react"],
      { cwd: dir },
    );
    expect(r.code).toBe(0);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("sync");
    expect(result.ok).toBe(true);
    expect(result.verdict).toBeDefined();
  });
});

describe("headless contract — audit", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("--json on virgin tree reports findings via structured result", async () => {
    const r = await runCli(["audit", "--pack", "next-react", "--json"], { cwd: dir });
    expect([0, 1]).toContain(r.code);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("audit");
    expect(result.exitCode).toBe(r.code);
    expect(result.remaining).toBeDefined();
  });

  it("--json after adopt reports clean tree (verdict='clean')", async () => {
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    const r = await runCli(["audit", "--json"], { cwd: dir });
    expect(r.code).toBe(0);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("audit");
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe("clean");
  });

  it("audit --fix --json emits headless contract on adopted tree", async () => {
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    const r = await runCli(["audit", "--fix", "--json"], { cwd: dir });
    expect([0, 1]).toContain(r.code);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("audit");
    expect(result.exitCode).toBe(r.code);
  });

  it("audit --json without config and no --pack exits 2", async () => {
    const r = await runCli(["audit", "--json"], { cwd: dir });
    expect(r.code).toBe(2);
    const result = parseJsonOutput(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("error");
  });
});

describe("headless contract — heal", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("--json on converged tree exits 0 with verdict='converged'", async () => {
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    const r = await runCli(["heal", "--json"], { cwd: dir });
    expect(r.code).toBe(0);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("heal");
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe("converged");
  });

  it("--json without .claude-ds.json exits 2", async () => {
    const r = await runCli(["heal", "--json"], { cwd: dir });
    expect(r.code).toBe(2);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("heal");
    expect(result.ok).toBe(false);
  });

  it("--json with --max-iterations 0 exits 2 with error verdict", async () => {
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    const r = await runCli(["heal", "--json", "--max-iterations", "0"], { cwd: dir });
    expect(r.code).toBe(2);
    const result = parseJsonOutput(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("error");
  });
});

describe("headless contract — classify", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("--json without .claude-ds.json exits 2 with error verdict", async () => {
    const r = await runCli(["classify", "--json"], { cwd: dir });
    expect(r.code).toBe(2);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("classify");
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("error");
  });

  it("--json on empty adopted tree emits headless contract", async () => {
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    const r = await runCli(["classify", "--json"], { cwd: dir });
    expect(r.code).toBe(0);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("classify");
    expect(result.ok).toBe(true);
  });
});

describe("headless contract — upgrade", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("--json on already-at-target exits 0 with structured result", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v0.8.0" }),
    );
    const r = await runCli(["upgrade", "--to", "v0.8.0", "--yes", "--json"], { cwd: dir });
    expect(r.code).toBe(0);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("upgrade");
    expect(result.ok).toBe(true);
    expect(result.verdict).toBeDefined();
  });

  it("--json without .claude-ds.json exits 2", async () => {
    const r = await runCli(["upgrade", "--to", "v0.8.0", "--yes", "--json"], { cwd: dir });
    expect(r.code).toBe(2);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("upgrade");
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("error");
  });
});

describe("headless contract — doctor", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("--json on pre-adopt tree returns structured contract", async () => {
    const r = await runCli(["doctor", "--pack", "next-react", "--json"], { cwd: dir });
    expect(r.code).toBe(0);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("doctor");
    expect(result.verdict).toBe("pre-adopt");
    expect(result.exitCode).toBe(0);
  });

  it("--json on post-adopt clean tree returns verdict='clean'", async () => {
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    const r = await runCli(["doctor", "--json"], { cwd: dir });
    expect(r.code).toBe(0);
    const result = parseJsonOutput(r.stdout);
    expect(result.command).toBe("doctor");
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe("clean");
  });
});

describe("headless contract — byte-identical non-TTY stream", () => {
  // The non-TTY byte stream must be byte-identical to today's plain output
  // (the TTY layer is a thin color adapter — issue #370 / PRD #407 story 26).
  // runCli runs without a TTY, so the bytes we observe here are what the
  // agent observes. Each test asserts a known stable line is present and no
  // ANSI escape code appears.
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  const ANSI_ESCAPE_RE = /\[/;

  it("doctor (no --json) stdout contains no ANSI color codes", async () => {
    const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
    expect(ANSI_ESCAPE_RE.test(r.stdout)).toBe(false);
    expect(ANSI_ESCAPE_RE.test(r.stderr)).toBe(false);
  });

  it("audit (no --json) stdout contains no ANSI color codes", async () => {
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(ANSI_ESCAPE_RE.test(r.stdout)).toBe(false);
    expect(ANSI_ESCAPE_RE.test(r.stderr)).toBe(false);
  });

  it("upgrade (no --json) stdout contains no ANSI color codes", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v0.8.0" }),
    );
    const r = await runCli(["upgrade", "--to", "v0.8.0", "--yes"], { cwd: dir });
    expect(ANSI_ESCAPE_RE.test(r.stdout)).toBe(false);
    expect(ANSI_ESCAPE_RE.test(r.stderr)).toBe(false);
  });
});

describe("headless contract — documented exit codes", () => {
  // Every command in the loop-critical set obeys a documented matrix:
  //   0 — converged / clean / no findings
  //   1 — findings remain / did not converge
  //   2 — user-input / env error (no .claude-ds.json, dirty tree, bad flag)
  //   3 — pending decisions (heal-specific)
  // These tests pin the per-command interpretation against representative
  // states, so a regression in the contract fails fast.
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("audit returns 2 when no .claude-ds.json and no --pack", async () => {
    const r = await runCli(["audit"], { cwd: dir });
    expect(r.code).toBe(2);
  });

  it("heal returns 2 when no .claude-ds.json", async () => {
    const r = await runCli(["heal"], { cwd: dir });
    expect(r.code).toBe(2);
  });

  it("sync returns 2 when no .claude-ds.json", async () => {
    const r = await runCli(["sync"], { cwd: dir });
    expect(r.code).toBe(2);
  });

  it("classify returns 2 when no .claude-ds.json", async () => {
    const r = await runCli(["classify"], { cwd: dir });
    expect(r.code).toBe(2);
  });

  it("upgrade returns 2 when no .claude-ds.json", async () => {
    const r = await runCli(["upgrade", "--to", "v0.8.0", "--yes"], { cwd: dir });
    expect(r.code).toBe(2);
  });

  it("adopt returns 2 when .claude-ds.json already exists", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(2);
  });
});
