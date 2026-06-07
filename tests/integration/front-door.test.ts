/**
 * The bare-`claude-ds` front door (PRD #325 sub-issue #331; rewired in #345 /
 * ADR-0018 to drive the shared remediation planner).
 *
 * Two axes are pinned here:
 *   - **Non-TTY** keeps today's commander help — the agent/automation contract.
 *   - **TTY / interactive** renders the "where you are / what's wrong" dashboard,
 *     then drives the *same* `planRemediation` brain `heal` uses: one commitment
 *     gate (preview rendered from the real planned `Change[]`), then auto-advance
 *     to clean, pausing only for genuine Ambiguities.
 *
 * The retired `recommendedNext` recommender is gone — no test asserts a
 * `→ Next: <type this>` breadcrumb any more. Instead we pin the commitment-gate
 * preview, the one-brain invariant (front door and heal produce the same ordered
 * plan), and the headless `--answers` drive.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { frontDoorCmd } from "../../src/commands/front-door";
import { loadProject } from "../../src/lib/project";
import { deriveProjectState } from "../../src/lib/project-state";
import { planRemediation } from "../../src/lib/remediation-planner";
import { buildCommitmentGate } from "../../src/lib/gate-preview";
import { makeSyncPackFiles } from "../../src/lib/ops/sync-pack-files";
import { run } from "../../src/lib/runner";
import pkg from "../../package.json" with { type: "json" };

const CURRENT = `v${pkg.version}`;

describe("bare `claude-ds` non-TTY (agent / automation)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("prints the commander help and does not run the dashboard", async () => {
    // runCli stubs stdin.isTTY to false and never sets stdout.isTTY, so this
    // exercises the non-TTY branch — the agent/automation contract is exactly
    // today's help bytes, no dashboard and no prompts.
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
    expect(r.stdout).not.toMatch(/Where you are:/);
  });
});

describe("frontDoorCmd (TTY dashboard + commitment gate)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("pre-adopt: renders the dashboard and routes to adopt (not a planner state)", async () => {
    const out = await captureFrontDoor({ cwd: dir });

    expect(out).toMatch(/Where you are: pre-adopt/);
    expect(out).toMatch(/Run `claude-ds adopt --pack next-react`/);
    // No commitment gate in pre-adopt — adopt hands the project INTO the loop.
    expect(out).not.toMatch(/\[Enter\] to run all/);
  });

  it("adopted + clean tree: nothing to remediate, routes to the build command", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    // #382: adopt now lands at the verification chain's fixed point, so heal is
    // a no-op here. The call is retained as a belt-and-braces guard against a
    // future migration that adds another end-state adopt doesn't yet seed.
    const healed = await runCli(["heal"], { cwd: dir });
    expect(healed.code).toBe(0);
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { build: "next build" } }));

    const out = await captureFrontDoor({ cwd: dir });

    expect(out).toMatch(/Where you are: adopted/);
    expect(out).toMatch(/Nothing to remediate — the tree is clean/);
    expect(out).toMatch(/Run `npm run build`/);
  });

  it("adopted + auto-fixable drift: the gate plans audit --fix", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    // A correctly-placed atom with the retired meta.states field →
    // DRIFT-STALE-META-STATES, an auto-fixable finding.
    await writeFile(
      join(dir, "design-system/atoms/solo-label.tsx"),
      `export const meta = { kind: 'atom' as const, states: { loading: true } };
export function SoloLabel() { return <span />; }
`,
    );

    const out = await captureFrontDoor({ cwd: dir });

    expect(out).toMatch(/Where you are: adopted/);
    expect(out).toMatch(/I'll bring this tree to clean/);
    expect(out).toMatch(/audit --fix — auto-repair \d+ finding/);
  });

  it("adopted + MISPLACED finding: the gate plans classify (#245)", async () => {
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

    expect(out).toMatch(/classify — extract \/ relocate/);
  });

  it("adopted + stale packVersion (clean tree): the gate plans upgrade first", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const cfgPath = join(dir, ".claude-ds.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    cfg.packVersion = "v0.0.1";
    await writeFile(cfgPath, JSON.stringify(cfg));

    const out = await captureFrontDoor({ cwd: dir });

    expect(out).toMatch(/What's wrong: .*upgrade available/);
    expect(out).toMatch(/upgrade — pack v0\.0\.1 → /);
  });

  it("adopted + missing managed files: the gate previews the real sync Change[]", async () => {
    // Seed config pinned to the CURRENT version (so upgrade does not lead) with
    // no scaffold on disk — the canonical "managed files missing" case. The gate
    // must render the real planned restores, one line per file.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      packVersion: CURRENT,
      pack: "next-react",
      mode: "warn",
      app_dir: "app",
      claude_md_target: ".claude/CLAUDE.md",
    }));

    const out = await captureFrontDoor({ cwd: dir });

    expect(out).toMatch(/sync — restore managed scaffold files/);
    // Real planned Change[] rendered as `A path` restore lines under the step.
    expect(out).toMatch(/^\s+A .+/m);
  });
});

describe("front door drives the shared planner (ADR-0018)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("one-brain invariant: the gate's plan IS planRemediation(deriveProjectState) — upgrade before audit", async () => {
    // A tree that is BOTH version-stale AND has auto-fixable drift. The retired
    // recommender ranked `upgrade` last (findings outranked it); the shared
    // planner ranks it first. This pins the structural guard against re-
    // divergence: the front door renders exactly the planner's ordered plan, and
    // that plan is what heal dispatches too (both call the same planner).
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const cfgPath = join(dir, ".claude-ds.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    cfg.packVersion = "v0.0.1";
    await writeFile(cfgPath, JSON.stringify(cfg));
    await writeFile(
      join(dir, "design-system/atoms/solo-label.tsx"),
      `export const meta = { kind: 'atom' as const, states: { loading: true } };
export function SoloLabel() { return <span />; }
`,
    );

    // The single ordering brain, computed directly.
    const state = await deriveProjectState(dir);
    const plan = planRemediation(state);
    expect(plan).toContain("upgrade");
    expect(plan).toContain("audit --fix");
    expect(plan.indexOf("upgrade")).toBeLessThan(plan.indexOf("audit --fix"));

    // The front door renders that exact ordered plan — no second brain, no
    // re-ordering. The gate header lists the plan joined by ` → `.
    const out = await captureFrontDoor({ cwd: dir });
    expect(out).toContain(plan.join(" → "));
  });

  it("F11: the gate preview count equals the planned Change[] (no divergent recommender)", async () => {
    // Seed a scaffold-less adopted tree pinned to CURRENT so the only byte-
    // deterministic step is sync. The gate's sync block must list exactly as
    // many file-change lines as the sync Op's own dry-run plans — the preview
    // IS the real planned Change[], not an independently-computed count.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      packVersion: CURRENT,
      pack: "next-react",
      mode: "warn",
      app_dir: "app",
      claude_md_target: ".claude/CLAUDE.md",
    }));

    const ctx = await loadProject(dir);
    const dryRun = await run(ctx, [makeSyncPackFiles({})], "dry-run", { quiet: true });
    const plannedCount = dryRun.ops.reduce((n, o) => n + o.changes.length, 0);
    expect(plannedCount).toBeGreaterThan(0);

    const gateLines = await buildCommitmentGate(ctx, ["sync"], {
      classifyCount: 0,
      autoFixableCount: 0,
    });
    const changeLineCount = gateLines.filter(l => /^\s+[AMRD] /.test(l)).length;

    expect(changeLineCount).toBe(plannedCount);
  });

  it("non-interactive without --yes is preview-only: changes nothing", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      packVersion: CURRENT,
      pack: "next-react",
      mode: "warn",
      app_dir: "app",
      claude_md_target: ".claude/CLAUDE.md",
    }));
    const before = await readFile(join(dir, ".claude-ds.json"), "utf8");

    await captureFrontDoor({ cwd: dir });

    // The scaffold is still absent — the preview drove nothing.
    let scaffoldRestored = true;
    try { await readFile(join(dir, "design-system/tokens.json"), "utf8"); }
    catch { scaffoldRestored = false; }
    expect(scaffoldRestored).toBe(false);
    expect(await readFile(join(dir, ".claude-ds.json"), "utf8")).toBe(before);
  });

  it("AC6: --answers drives the loop to a fixed point without a TTY", async () => {
    // Equidistant-token Ambiguity (the heal #333 fixture): `padding: 12` ties
    // between spacing-2 (8) and spacing-4 (16). With a pre-supplied --answers
    // file the front door resolves it silently and converges — the no-pseudo-TTY
    // automation path. Pairs `interactive: false` with `yes: true` (the headless
    // authorization) so no [Enter] is awaited.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      packVersion: "v0.9.0",
      pack: "next-react",
      mode: "warn",
      domain_roots: ["features", "lib"],
      ds_aliases: ["@ds"],
    }));
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(
      join(dir, "design-system/tokens.json"),
      JSON.stringify({ spacing: { 2: "8", 4: "16" } }),
    );
    await writeFile(
      join(dir, "design-system/atoms/card.tsx"),
      [
        `export function Card() { return <div style={{ padding: 12 }}>x</div>; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
        ``,
      ].join("\n"),
    );

    const answersPath = join(dir, "answers.json");
    await writeFile(answersPath, JSON.stringify({
      "DRIFT-INLINE-STATIC-STYLE:design-system/atoms/card.tsx::token-tie:padding:12": 0,
    }));

    const out = await captureFrontDoor({
      cwd: dir,
      interactive: false,
      yes: true,
      answers: answersPath,
      maxIterations: 5,
    });

    // Converged: the front door printed the clean verdict and the fixer ran
    // (padding: 12 → token), with no Ambiguity ever blocking the headless loop.
    expect(out).toMatch(/Tree is clean/);
    const card = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
    expect(card).not.toContain("padding: 12");
  }, 60000);
});

/**
 * Drive the orchestrator directly, capturing stdout. Defaults to
 * `interactive: false` with no `yes`, so by default this renders the dashboard
 * + commitment-gate preview and stops — it changes nothing on disk. Pass
 * `yes: true` (and `answers`) to exercise the headless drive.
 */
async function captureFrontDoor(opts: {
  cwd: string;
  interactive?: boolean;
  yes?: boolean;
  answers?: string;
  maxIterations?: number;
}): Promise<string> {
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
    await frontDoorCmd({ interactive: false, ...opts });
  } finally {
    process.stdout.write = origStdoutWrite as typeof process.stdout.write;
    console.log = origConsoleLog;
    console.info = origConsoleInfo;
  }
  return stdout;
}
