/**
 * PRD #325 sub-issue #331 — bare `claude-ds` gains a default action: a
 * state-aware dashboard in TTY, today's help/`--json` in non-TTY. The
 * non-TTY path is the agent/automation contract and must not change shape,
 * so this suite pins both axes.
 *
 * The TTY path runs the same compose function the unit tests pin
 * (`composeDashboardState`); these tests exercise the orchestrator end-to-end
 * against fixture projects (clean, drifty, missing scaffold) and assert that
 * the rendered dashboard names the recommended next command the brain picked.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { frontDoorCmd } from "../../src/commands/front-door";

describe("bare `claude-ds` non-TTY (agent / automation)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("prints the commander help and does not run the dashboard", async () => {
    // runCli stubs stdin.isTTY to false and never sets stdout.isTTY, so this
    // exercises the non-TTY branch. The agent/automation contract is exactly
    // today's behavior — no auto-audit, no interactive prompts.
    //
    // PRD #325 sub-issue #334 reserves the no-config path for the first-run
    // greet, so we seed a minimal `.claude-ds.json` here: the agent-help
    // contract applies to *adopted* projects, where the dashboard front-door
    // is the human surface and non-TTY keeps the help bytes. The first-run
    // greet's non-TTY behavior is tested in `greet.test.ts`.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      packVersion: "v0.8.0",
      pack: "next-react",
      mode: "warn",
      app_dir: "app",
      claude_md_target: ".claude/CLAUDE.md",
    }));

    const r = await runCli([], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage:\s*claude-ds/);
    // The dashboard's "Where you are:" line must not appear in non-TTY.
    expect(r.stdout).not.toMatch(/Where you are:/);
  });
});

describe("frontDoorCmd (TTY dashboard orchestrator)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("pre-adopt: renders the dashboard with an adopt recommendation", async () => {
    // No .claude-ds.json → pre-adopt mode. The brain picks `adopt --pack`.
    const out = await captureFrontDoor({ cwd: dir });

    expect(out).toMatch(/Where you are: pre-adopt/);
    expect(out).toMatch(/→ Next: claude-ds adopt --pack next-react — install the design-system scaffold/);
  });

  it("adopted + clean tree: renders the dashboard with a build recommendation", async () => {
    // Adopt installs the full managed scaffold so the brain's "missing
    // managed" sentinel doesn't outrank the audit/build axes.
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { build: "next build" } }));

    const out = await captureFrontDoor({ cwd: dir });

    expect(out).toMatch(/Where you are: adopted/);
    expect(out).toMatch(/→ Next: npm run build — verify everything compiles/);
  });

  it("adopted + drifty tree: recommendation routes to audit --fix", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    // A correctly-placed atom with the retired meta.states field produces
    // DRIFT-STALE-META-STATES — an auto-fixable finding, so the brain should
    // route to `audit --fix` (matches printNextStep's breadcrumb engine, #245).
    await writeFile(
      join(dir, "design-system/atoms/solo-label.tsx"),
      `export const meta = { kind: 'atom' as const, states: { loading: true } };
export function SoloLabel() { return <span />; }
`,
    );

    const out = await captureFrontDoor({ cwd: dir });

    expect(out).toMatch(/Where you are: adopted/);
    expect(out).toMatch(/→ Next: claude-ds audit --fix/);
  });

  it("adopted + MISPLACED finding: recommendation routes to classify (#245)", async () => {
    // Same scenario the breadcrumbs integration test pins for `audit`: a
    // composite-shaped atom (3 DS imports) produces DRIFT-MISPLACED, which
    // `audit --fix` can't repair — only classify can. The dashboard must say so.
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    for (const name of ["card", "button", "input"]) {
      await writeFile(
        join(dir, `design-system/atoms/${name}.tsx`),
        `export function ${name[0].toUpperCase()}${name.slice(1)}() { return <div />; }\n`,
      );
    }
    await writeFile(
      join(dir, "design-system/atoms/sidebar.tsx"),
      `import { Card } from "@/design-system/atoms/card";
import { Button } from "@/design-system/atoms/button";
import { Input } from "@/design-system/atoms/input";
export function Sidebar() { return <Card><Button /><Input /></Card>; }
`,
    );

    const out = await captureFrontDoor({ cwd: dir });

    expect(out).toMatch(/→ Next: claude-ds classify/);
    expect(out).not.toMatch(/→ Next: claude-ds audit --fix/);
  });

  it("adopted + missing managed files: recommendation routes to sync", async () => {
    // No `adopt` here — a freshly-seeded `.claude-ds.json` with no scaffold
    // is exactly the "managed files missing" path the brain prefers over
    // downstream audit/build advice. This is the "missing scaffold" fixture
    // the acceptance criterion calls out.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      packVersion: "v0.8.0",
      pack: "next-react",
      mode: "warn",
      app_dir: "app",
      claude_md_target: ".claude/CLAUDE.md",
    }));

    const out = await captureFrontDoor({ cwd: dir });

    expect(out).toMatch(/Where you are: adopted/);
    expect(out).toMatch(/→ Next: claude-ds sync — restore \d+ missing managed file/);
  });
});

/**
 * Drive the orchestrator directly. Going through `runCli` would force every
 * test to fake the stdout.isTTY gate the CLI checks — driving the orchestrator
 * here keeps the brain assertions independent of that gate (which we test in
 * the non-TTY suite above).
 *
 * `interactive: false` skips the [Enter]-to-dispatch readline so tests don't
 * hang waiting for stdin. The dispatch path is exercised by the unit test
 * pinning the recommendation shape; integration is about the rendered output.
 */
async function captureFrontDoor(opts: { cwd: string }): Promise<string> {
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origConsoleLog = console.log;
  const origConsoleInfo = console.info;
  let stdout = "";
  const fmt = (args: unknown[]) =>
    args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(" ") + "\n";
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    stdout += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    const cb = rest.find((r) => typeof r === "function") as ((err?: Error) => void) | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => { stdout += fmt(args); };
  console.info = (...args: unknown[]) => { stdout += fmt(args); };
  try {
    await frontDoorCmd({ cwd: opts.cwd, interactive: false });
  } finally {
    process.stdout.write = origStdoutWrite as typeof process.stdout.write;
    console.log = origConsoleLog;
    console.info = origConsoleInfo;
  }
  return stdout;
}
