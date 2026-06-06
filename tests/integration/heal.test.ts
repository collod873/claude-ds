import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";

// Issue #265 — the two-pass `classify → audit --fix → classify → audit --fix`
// workaround is a tracked completeness-principle defect (ADR-0003). `claude-ds
// heal` is the self-converging command that replaces it: a single invocation
// drives the consumer tree to a fixed point or fails loudly within a bounded
// iteration ceiling.
//
// The Crewops 72c6dde shape we reproduce: an atom whose import block was
// stripped (UNRESOLVED-SYMBOL) and whose helpers used to live alongside it
// reference 3+ DS atoms. At classify-time the corrupt baseline has 0 imports,
// so classify scores it `atom` and leaves it in atoms/. The first
// `audit --fix` re-derives the import closure; now the file is unambiguously
// composite, but classify already ran and audit cannot relocate (ADR-0015) —
// so the file sits in atoms/ as a DRIFT-MISCLASSIFIED-ATOM until a second
// classify pass moves it.
//
// `claude-ds heal` runs the sequence as a fixed-point loop and is the test's
// subject.

const BASE_CFG = {
  packVersion: "v0.9.0",
  pack: "next-react",
  mode: "warn",
  domain_roots: ["features", "lib"],
  ds_aliases: ["@ds"],
};

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

describe("claude-ds heal — self-converging brownfield loop (#265)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("converges a corrupt-baseline atom into composites/ in ONE command", async () => {
    // ── Brownfield fixture (Crewops 72c6dde shape) ──
    //
    // Three plain atoms that the classifier confidently scores `atom`.
    // The corrupt atom `combo.tsx` *uses* all three but has 0 imports — so:
    //   - First classify pass: classifier says atom (no DS imports), leaves it in atoms/.
    //   - First audit --fix: re-derives the imports (Button, Input, Badge).
    //   - File now composes 3 DS components — unambiguously composite — but audit
    //     cannot relocate (ADR-0015), so it stays in atoms/ as DRIFT-MISCLASSIFIED-ATOM.
    //   - Second classify pass relocates atoms/combo.tsx → composites/combo.tsx.
    //   - Second audit --fix: 0 changes, 0 findings.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@ds/*": ["./design-system/*"] } } }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });

    for (const name of ["button", "input", "badge"]) {
      const Name = name[0].toUpperCase() + name.slice(1);
      await writeFile(
        join(dir, `design-system/atoms/${name}.tsx`),
        `export function ${Name}() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      );
    }

    // The corrupt atom: references Button/Input/Badge with NO import block at
    // all. INTEGRITY-UNRESOLVED-SYMBOL fires; the audit-fix re-derives imports
    // from the resolution graph, at which point the file is provably composite.
    await writeFile(
      join(dir, "design-system/atoms/combo.tsx"),
      [
        `export function Combo() { return <div><Button/><Input/><Badge/></div>; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
        "",
      ].join("\n"),
    );

    // ── A single `claude-ds heal` invocation must reach the fixed point. ──
    const heal = await runCli(["heal"], { cwd: dir });

    // Convergence on the first command: file relocated to composites/, every
    // dangling unresolved symbol healed, audit reports 0 findings on the final
    // read-only pass embedded in heal.
    expect(heal.code).toBe(0);
    expect(await fileExists(join(dir, "design-system/composites/combo.tsx"))).toBe(true);
    expect(await fileExists(join(dir, "design-system/atoms/combo.tsx"))).toBe(false);

    const healed = await readFile(join(dir, "design-system/composites/combo.tsx"), "utf8");
    expect(healed).toMatch(/import\s+\{\s*Button\s*\}\s+from\s+["']@ds\/atoms\/button["']/);
    expect(healed).toMatch(/import\s+\{\s*Input\s*\}\s+from\s+["']@ds\/atoms\/input["']/);
    expect(healed).toMatch(/import\s+\{\s*Badge\s*\}\s+from\s+["']@ds\/atoms\/badge["']/);

    // ── Idempotency: a second `heal` from the converged state is a no-op. ──
    const heal2 = await runCli(["heal"], { cwd: dir });
    expect(heal2.code).toBe(0);
    expect(heal2.stdout).toMatch(/converged/);
  }, 30000);

  it("exits non-zero with an actionable error when the ceiling is hit", async () => {
    // Acceptance #4 — bounded ceiling. Force the loop to fail by capping it at
    // a number lower than what the corrupt baseline needs to converge.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@ds/*": ["./design-system/*"] } } }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });

    for (const name of ["button", "input", "badge"]) {
      const Name = name[0].toUpperCase() + name.slice(1);
      await writeFile(
        join(dir, `design-system/atoms/${name}.tsx`),
        `export function ${Name}() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      );
    }
    await writeFile(
      join(dir, "design-system/atoms/combo.tsx"),
      [
        `export function Combo() { return <div><Button/><Input/><Badge/></div>; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
        "",
      ].join("\n"),
    );

    const r = await runCli(["heal", "--max-iterations", "1"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/did not converge/);
  }, 30000);

  it("rejects non-positive-integer --max-iterations with an actionable error", async () => {
    // `parseInt("abc")` is NaN; `--max-iterations 0` and negatives are
    // similarly degenerate. Without input validation the loop body never
    // runs and heal prints "did not converge after NaN iterations" — a
    // confusing failure for a user-input error. Exit 2 (user error) per
    // the convention sync/upgrade/classify already follow.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    for (const bad of ["abc", "0", "-1"]) {
      const r = await runCli(["heal", "--max-iterations", bad], { cwd: dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/--max-iterations must be a positive integer/);
    }
  });

  // Issue #300 — heal converges drifted migration end-states. The Crewops
  // reproducer: pack at v1.0.0 with `meta_kind_strict: false` despite the
  // v0.9.0 meta-kind-hard migration. A single `heal` invocation must restore
  // the flag — the migration's end-state — without prompting the consumer.
  it("self-corrects a drifted meta_kind_strict on a v1.0.0 baseline (#300)", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v1.0.0", meta_kind_strict: false }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      `export function Button() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
    );

    const r = await runCli(["heal"], { cwd: dir });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.meta_kind_strict).toBe(true);
  }, 30000);

  it("reports `converged` and exits 0 on an already-clean tree", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      `export function Button() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
    );

    const r = await runCli(["heal"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/converged/);
  }, 15000);
});
