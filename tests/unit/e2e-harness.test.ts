/**
 * Tests of the e2e harness itself — not of any real CLI behavior.
 *
 * The harness is the instrument; its job is to drive a subprocess against a
 * fixture and emit a structured deviation report. These tests stub the CLI
 * and `tsc` with tiny Node scripts so we can verify the machinery — exit
 * code capture, on-disk filesystem checks, tsc-output parsing, deviation
 * categorization — without depending on a real built `dist/cli.js`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { freshTmpDir, cleanup } from "../helpers/tmpdir.js";
import {
  runE2eHarness,
  parseTscOutput,
  writeReport,
  type HarnessReport,
} from "../e2e/harness.js";

/**
 * Build a stub fixture with the minimum files the harness's filesystem
 * checks expect after `adopt → heal`. Used by tests that exercise the
 * happy path; tests that probe failure modes start from this and remove
 * files / scripts as needed.
 */
async function buildHappyFixture(dir: string): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "stub" }));
  await writeFile(join(dir, "tsconfig.json"), JSON.stringify({}));
}

interface StubCliBehavior {
  /** Exit code for `adopt`. Default 0. */
  adoptExit?: number;
  /** Exit code for `heal`. Default 0. */
  healExit?: number;
  /** Any extra stdout the heal step should print. */
  healStdout?: string;
  /** When true, the fake CLI skips writing the post-adopt managed scaffold. */
  skipManagedScaffold?: boolean;
  /**
   * Optional extra TSX files (path → contents) the fake CLI writes during
   * `heal`. Tests use this to drop in an intentional duplicate-meta file.
   */
  extraFiles?: Record<string, string>;
}

const REQUIRED_MANAGED = [
  "design-system/types/meta.ts",
  "design-system/contracts/runner.ts",
  "design-system/contracts/roles/index.ts",
  "design-system/contracts/roles/types.ts",
  "design-system/contracts/roles/combobox.ts",
  "design-system/manifest.json",
];

/**
 * Write a fake CLI that mimics just enough of `claude-ds` for the harness's
 * filesystem assertions to fire. The script branches on `argv[2]`:
 *   - `adopt`: writes .claude-ds.json + the managed scaffold (unless skipped),
 *              exits with `adoptExit`.
 *   - `heal` : writes any `extraFiles`, exits with `healExit`.
 */
async function writeFakeCli(path: string, b: StubCliBehavior): Promise<void> {
  const adoptExit = b.adoptExit ?? 0;
  const healExit = b.healExit ?? 0;
  const skip = b.skipManagedScaffold ?? false;
  const extras = b.extraFiles ?? {};
  const required = JSON.stringify(REQUIRED_MANAGED);
  const extrasJson = JSON.stringify(extras);
  const script = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const cmd = process.argv[2];
const cwd = process.cwd();
async function w(rel, content) {
  const abs = join(cwd, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}
if (cmd === "adopt") {
  await w(".claude-ds.json", JSON.stringify({ pack: "next-react", mode: "warn" }));
  if (!${skip}) {
    for (const f of ${required}) await w(f, "// managed scaffold stub\\n");
  }
  process.stdout.write("adopt: ok\\n");
  process.exit(${adoptExit});
}
if (cmd === "heal") {
  const extras = ${extrasJson};
  for (const [p, c] of Object.entries(extras)) await w(p, c);
  process.stdout.write(${JSON.stringify(b.healStdout ?? "heal: converged\n")});
  process.exit(${healExit});
}
process.stderr.write("fake-cli: unknown command " + cmd + "\\n");
process.exit(2);
`;
  await writeFile(path, script);
}

interface StubTscBehavior {
  exit: number;
  stdout?: string;
}

/** Fake tsc that prints any provided stdout and exits with `exit`. */
async function writeFakeTsc(path: string, b: StubTscBehavior): Promise<void> {
  const script = `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(b.stdout ?? "")});
process.exit(${b.exit});
`;
  await writeFile(path, script);
}

describe("e2e harness", () => {
  let fixtureDir: string;
  let workDir: string;
  let cliPath: string;
  let tscPath: string;
  let scratch: string;

  beforeEach(async () => {
    scratch = await freshTmpDir("e2eh-");
    fixtureDir = join(scratch, "fixture");
    workDir = join(scratch, "work");
    cliPath = join(scratch, "fake-cli.mjs");
    tscPath = join(scratch, "fake-tsc.mjs");
    await mkdir(fixtureDir, { recursive: true });
    await buildHappyFixture(fixtureDir);
  });
  afterEach(async () => {
    await cleanup(scratch);
  });

  it("happy path: produces pass=true with no deviations", async () => {
    await writeFakeCli(cliPath, {});
    await writeFakeTsc(tscPath, { exit: 0 });

    const report = await runE2eHarness({ fixtureDir, cliPath, tscPath, workDir });

    expect(report.pass).toBe(true);
    expect(report.deviations).toEqual([]);
    expect(report.steps.map((s) => s.name)).toEqual(["adopt", "heal", "tsc"]);
    for (const s of report.steps) expect(s.exitCode).toBe(0);
    expect(report.tsc?.exitCode).toBe(0);
    expect(report.tsc?.errorCount).toBe(0);
    expect(report.fixture).toBe("fixture");
    expect(Date.parse(report.startedAt)).toBeGreaterThan(0);
    expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
  });

  it("copies the fixture into workDir before running adopt", async () => {
    await writeFile(join(fixtureDir, "marker.txt"), "i-was-here");
    await writeFakeCli(cliPath, {});
    await writeFakeTsc(tscPath, { exit: 0 });

    await runE2eHarness({ fixtureDir, cliPath, tscPath, workDir });

    expect(existsSync(join(workDir, "marker.txt"))).toBe(true);
    expect(await readFile(join(workDir, "marker.txt"), "utf8")).toBe("i-was-here");
  });

  it("captures adopt failure and short-circuits before heal/tsc", async () => {
    await writeFakeCli(cliPath, { adoptExit: 2 });
    await writeFakeTsc(tscPath, { exit: 0 });

    const report = await runE2eHarness({ fixtureDir, cliPath, tscPath, workDir });

    expect(report.pass).toBe(false);
    expect(report.steps.map((s) => s.name)).toEqual(["adopt"]);
    expect(report.steps[0].exitCode).toBe(2);
    const adoptFailed = report.deviations.find((d) => d.category === "adopt-failed");
    expect(adoptFailed).toBeDefined();
    expect(adoptFailed?.detail).toMatch(/exited 2/);
    expect(report.tsc).toBeUndefined();
  });

  it("flags heal exit 1 as did-not-converge but still runs tsc", async () => {
    await writeFakeCli(cliPath, { healExit: 1, healStdout: "heal: stuck\n" });
    await writeFakeTsc(tscPath, { exit: 0 });

    const report = await runE2eHarness({ fixtureDir, cliPath, tscPath, workDir });

    expect(report.steps.map((s) => s.name)).toEqual(["adopt", "heal", "tsc"]);
    expect(report.steps[1].exitCode).toBe(1);
    const healFailed = report.deviations.find((d) => d.category === "heal-failed");
    expect(healFailed?.detail).toMatch(/did not converge/);
    expect(report.tsc?.exitCode).toBe(0);
  });

  it("flags heal exit 3 as HEAL_EXIT_PENDING and continues", async () => {
    await writeFakeCli(cliPath, { healExit: 3 });
    await writeFakeTsc(tscPath, { exit: 0 });

    const report = await runE2eHarness({ fixtureDir, cliPath, tscPath, workDir });

    const healFailed = report.deviations.find((d) => d.category === "heal-failed");
    expect(healFailed?.detail).toMatch(/HEAL_EXIT_PENDING/);
    expect(report.steps[2].name).toBe("tsc");
  });

  it("reports missing managed files when the CLI skips writing them", async () => {
    await writeFakeCli(cliPath, { skipManagedScaffold: true });
    await writeFakeTsc(tscPath, { exit: 0 });

    const report = await runE2eHarness({ fixtureDir, cliPath, tscPath, workDir });

    expect(report.pass).toBe(false);
    const missing = report.deviations.filter((d) => d.category === "missing-managed-file");
    expect(missing.length).toBe(REQUIRED_MANAGED.length);
    for (const d of missing) expect(d.file).toMatch(/design-system\//);
  });

  it("reports missing config when adopt exits 0 but writes no .claude-ds.json", async () => {
    // Stub CLI that returns 0 from adopt but writes no files.
    await writeFile(cliPath, `#!/usr/bin/env node\nprocess.exit(0);\n`);
    await writeFakeTsc(tscPath, { exit: 0 });

    const report = await runE2eHarness({ fixtureDir, cliPath, tscPath, workDir });

    expect(report.pass).toBe(false);
    expect(report.deviations.find((d) => d.category === "missing-config")).toBeDefined();
    // No heal/tsc once config is missing — the report fails fast.
    expect(report.steps.map((s) => s.name)).toEqual(["adopt"]);
  });

  it("detects duplicate `export const meta` declarations (A1 catalogue entry)", async () => {
    const dupTsx = [
      'import type { Meta } from "@ds/types/meta";',
      "export function Foo() { return null; }",
      "export const meta: Meta = { kind: \"atom\", examples: [] };",
      "// duplicate appended by the broken fixer:",
      "export const meta = { kind: \"atom\", examples: [] };",
      "",
    ].join("\n");
    await writeFakeCli(cliPath, {
      extraFiles: { "design-system/atoms/Foo.tsx": dupTsx },
    });
    await writeFakeTsc(tscPath, { exit: 0 });

    const report = await runE2eHarness({ fixtureDir, cliPath, tscPath, workDir });

    const dup = report.deviations.find((d) => d.category === "duplicate-meta-decl");
    expect(dup).toBeDefined();
    expect(dup?.file).toBe("design-system/atoms/Foo.tsx");
    expect(dup?.detail).toMatch(/2 .* declarations/);
  });

  it("parses tsc errors and reports one deviation per error", async () => {
    const tscOut = [
      "design-system/atoms/Input.tsx(7,14): error TS2304: Cannot find name 'Meta'.",
      "design-system/composites/SearchBox.tsx(3,8): error TS2300: Duplicate identifier 'meta'.",
      "",
      "Found 2 errors in 2 files.",
    ].join("\n");
    await writeFakeCli(cliPath, {});
    await writeFakeTsc(tscPath, { exit: 2, stdout: tscOut });

    const report = await runE2eHarness({ fixtureDir, cliPath, tscPath, workDir });

    expect(report.tsc?.exitCode).toBe(2);
    expect(report.tsc?.errorCount).toBe(2);
    expect(report.tsc?.errors[0]).toMatchObject({
      file: "design-system/atoms/Input.tsx",
      line: 7,
      col: 14,
      code: "TS2304",
    });
    const tscFailed = report.deviations.find((d) => d.category === "consumer-tsc-failed");
    expect(tscFailed?.detail).toMatch(/2 error/);
    const tscErrs = report.deviations.filter((d) => d.category === "consumer-tsc-error");
    expect(tscErrs.length).toBe(2);
    expect(tscErrs[0].file).toBe("design-system/atoms/Input.tsx");
  });

  it("rejects with a clear message when the CLI binary is missing", async () => {
    await writeFakeTsc(tscPath, { exit: 0 });
    await expect(
      runE2eHarness({ fixtureDir, cliPath: join(scratch, "does-not-exist.js"), tscPath, workDir }),
    ).rejects.toThrow(/CLI not built/);
  });

  it("writeReport persists the report as canonical JSON", async () => {
    const report: HarnessReport = {
      fixture: "stub",
      pass: true,
      steps: [],
      deviations: [],
      startedAt: "2026-06-08T00:00:00.000Z",
      finishedAt: "2026-06-08T00:00:01.000Z",
    };
    const out = join(scratch, "nested", "report.json");
    await writeReport(report, out);
    const parsed = JSON.parse(await readFile(out, "utf8"));
    expect(parsed.fixture).toBe("stub");
    expect(parsed.pass).toBe(true);
  });
});

describe("parseTscOutput", () => {
  it("returns zero errors on empty input", () => {
    const r = parseTscOutput("", 0);
    expect(r.errorCount).toBe(0);
    expect(r.errors).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it("parses multi-line tsc diagnostics regardless of stdout/stderr split", () => {
    const raw = [
      "foo/bar.ts(1,2): error TS1234: Some message.",
      "foo/baz.tsx(10,20): error TS5678: Another message with: a colon.",
    ].join("\n");
    const r = parseTscOutput(raw, 1);
    expect(r.errorCount).toBe(2);
    expect(r.errors[1]).toMatchObject({
      file: "foo/baz.tsx",
      line: 10,
      col: 20,
      code: "TS5678",
      message: "Another message with: a colon.",
    });
  });

  it("ignores non-diagnostic noise lines", () => {
    const raw = "Found 1 error in 1 file.\nsome/file.ts(5,5): error TS9999: x.\n";
    const r = parseTscOutput(raw, 1);
    expect(r.errorCount).toBe(1);
    expect(r.errors[0].code).toBe("TS9999");
  });
});
