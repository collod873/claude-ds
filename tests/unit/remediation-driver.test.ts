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
import { writeFile, mkdir } from "node:fs/promises";
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

  it("snapshots DS-managed files but skips build/generated dirs (#384)", async () => {
    // A DS-managed file the loop mutates — MUST be watched for convergence.
    await seed("design-system/atoms/button.tsx", "export const Button = () => null;\n");
    // Build/generated output the loop never touches — MUST be skipped (OOM on
    // real trees walks the gigabyte .next cache twice per iteration).
    await seed(".next/cache/huge.txt", "build cache");
    await seed(".next/static/chunk.js", "chunk");
    await seed("dist/bundle.js", "bundle");
    await seed("coverage/lcov.info", "coverage");

    const snap = await snapshotTree(dir);

    expect(snap.has(join("design-system", "atoms", "button.tsx"))).toBe(true);

    const skipped = [".next", "dist", "coverage"];
    for (const key of snap.keys()) {
      const segments = key.split(/[/\\]/);
      for (const dirName of skipped) {
        expect(segments).not.toContain(dirName);
      }
    }
  });
});
