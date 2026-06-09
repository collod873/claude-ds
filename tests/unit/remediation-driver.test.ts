/**
 * The shared remediation driver (#345 / ADR-0018). `heal` and the front door
 * are two consumers of `driveRemediation`; this suite pins the driver's
 * UI-neutral contract directly, independent of either caller's exit-code or
 * prose interpretation.
 *
 * The loop's *convergence* behavior (snapshot fixed-point, Pending early-exit,
 * ceiling) is exercised end-to-end through `heal.test.ts`; here we pin the
 * thinner guarantees the driver owns on its own: an immediately-clean tree
 * converges in one iteration with zero dispatch, and the iteration callback is
 * driven once per iteration so callers can flavor their own logging.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { runCli } from "../helpers/runcli";
import { driveRemediation, snapshotTree } from "../../src/lib/remediation-driver";
import pkg from "../../package.json" with { type: "json" };

// A no-op progress controller (the non-TTY shape) so the driver runs without a
// spinner. Mirrors `NOOP_PROGRESS` without importing the TTY module.
const NOOP_PROGRESS = {
  start() {},
  succeed() {},
  fail() {},
  info() {},
  stop() {},
  active: false,
  enabled: false,
} as const;

describe("driveRemediation (shared loop)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("a clean tree converges in one iteration and dispatches nothing", async () => {
    // #382: adopt lands at the verification chain's fixed point, so the
    // following heal is a no-op. The call is kept as a guard against a future
    // migration adding an end-state adopt doesn't yet seed.
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const healed = await runCli(["heal"], { cwd: dir });
    expect(healed.code).toBe(0);

    const iterations: number[] = [];
    const outcome = await driveRemediation({
      cwd: dir,
      maxIterations: 3,
      progress: { ...NOOP_PROGRESS },
      onIteration: (i) => iterations.push(i),
    });

    expect(outcome).toEqual({ kind: "converged", iterations: 1 });
    // Empty plan on iteration 1 → the callback fired exactly once, no dispatch.
    expect(iterations).toEqual([1]);
  });

  // #470: the retired `enforce` command is folded into the driver. At
  // convergence the brain promotes the hook mode WARN → BLOCK once the tree is
  // clean and the open-exception count is within `enforce_threshold` — the
  // WARN→BLOCK call a consumer used to hand-type `enforce` for.
  it("promotes warn→block at convergence when exceptions are within threshold (#470)", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    // adopt lands in WARN (brownfield install) — the precondition the fold acts on.
    const cfgPath = join(dir, ".claude-ds.json");
    const before = JSON.parse(await readFile(cfgPath, "utf8"));
    expect(before.mode).toBe("warn");

    const outcome = await driveRemediation({
      cwd: dir,
      maxIterations: 3,
      progress: { ...NOOP_PROGRESS },
    });
    expect(outcome.kind).toBe("converged");

    const after = JSON.parse(await readFile(cfgPath, "utf8"));
    expect(after.mode).toBe("block");
  }, 30000);

  it("leaves warn untouched at convergence when open exceptions exceed threshold (#470)", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const cfgPath = join(dir, ".claude-ds.json");

    // Force threshold below the open-exception count: 1 open exception, threshold 0.
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    cfg.enforce_threshold = 0;
    cfg.mode = "warn";
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    await writeFile(
      join(dir, "design-system/exceptions.json"),
      JSON.stringify({ exceptions: [{ rule: "DRIFT-MISPLACED", path: "design-system/atoms/x.tsx", reason: "tracked", issue: "#1" }] }, null, 2) + "\n",
    );

    const outcome = await driveRemediation({
      cwd: dir,
      maxIterations: 3,
      progress: { ...NOOP_PROGRESS },
    });
    expect(outcome.kind).toBe("converged");

    const after = JSON.parse(await readFile(cfgPath, "utf8"));
    expect(after.mode).toBe("warn");
  }, 30000);

  it("empty plan + unresolvableFindings does NOT silently converge (#379)", async () => {
    // Adopt + heal to a fixed point, then introduce a ROLE-NO-CONTRACT finding
    // (an atom with `meta.role="tabs"` — no shipped contract). Its rule is
    // `fixable: false` AND `classifyRelocatable: false`, so `deriveProjectState`
    // sets only `unresolvableFindings` and `planRemediation` returns []. Before
    // this guard the driver's early-exit treated empty plan as `converged`,
    // re-introducing the exact silent-success regression #379 set out to
    // prevent. Surface it as non-convergence so heal exits loudly.
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    const healed = await runCli(["heal"], { cwd: dir });
    expect(healed.code).toBe(0);

    await writeFile(
      join(dir, "design-system/atoms/tabs.tsx"),
      `export function Tabs() { return <div/>; }
export const meta = { kind: "atom" as const, role: "tabs" as const, examples: [] };
`,
    );

    const outcome = await driveRemediation({
      cwd: dir,
      maxIterations: 2,
      progress: { ...NOOP_PROGRESS },
    });
    expect(outcome).toEqual({ kind: "exhausted", lastStep: null });
  }, 60000);

  it("forwards the iteration ceiling to the onIteration callback", async () => {
    // A scaffold-less tree pinned to the current version always has work
    // (sync), so the loop runs at least one iteration before it can converge —
    // enough to prove the callback is driven and the ceiling is forwarded.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      packVersion: `v${pkg.version}`,
      pack: "next-react",
      mode: "warn",
      app_dir: "app",
      claude_md_target: ".claude/CLAUDE.md",
    }));

    const iterations: number[] = [];
    const outcome = await driveRemediation({
      cwd: dir,
      maxIterations: 2,
      progress: { ...NOOP_PROGRESS },
      onIteration: (i, max) => {
        expect(max).toBe(2);
        iterations.push(i);
      },
    });

    // Either it converged (≤2 iters) or it exhausted — either way the callback
    // fired at least once and never past the ceiling.
    expect(iterations.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...iterations)).toBeLessThanOrEqual(2);
    expect(["converged", "exhausted"]).toContain(outcome.kind);
  }, 30000);
});

describe("snapshotTree (convergence detector)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  async function seed(rel: string, content: string): Promise<void> {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  it("snapshots DS-managed files but skips build/generated dirs (#384, #385)", async () => {
    // A DS-managed file the loop mutates — MUST be watched for convergence.
    await seed("design-system/atoms/button.tsx", "export const Button = () => null;\n");
    // Build/generated output the loop never touches — MUST be skipped (OOM on
    // real trees walks the gigabyte .next cache twice per iteration). The
    // Vite/Nuxt/Parcel caches are the #385 retrigger: pre-consolidation
    // SNAPSHOT_SKIP only knew about .next.
    await seed(".next/cache/huge.txt", "build cache");
    await seed(".next/static/chunk.js", "chunk");
    await seed(".nuxt/dist/server.mjs", "nuxt build");
    await seed(".vite/deps/_metadata.json", "vite cache");
    await seed(".parcel-cache/blob", "parcel cache");
    await seed("dist/bundle.js", "bundle");
    await seed("coverage/lcov.info", "coverage");

    const snap = await snapshotTree(dir);

    expect(snap.has(join("design-system", "atoms", "button.tsx"))).toBe(true);

    const skipped = [".next", ".nuxt", ".vite", ".parcel-cache", "dist", "coverage"];
    for (const key of snap.keys()) {
      const segments = key.split(/[/\\]/);
      for (const dirName of skipped) {
        expect(segments).not.toContain(dirName);
      }
    }
  });
});
