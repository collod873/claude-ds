import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import pkg from "../../package.json" with { type: "json" };

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

  // Issue #343 / ADR-0018 — `heal` obtains its step order from the shared
  // remediation planner, not a hardcoded sequence. The pre-#343 sequence
  // hardcoded `sync → upgrade → classify → audit --fix` (prelude + loop);
  // the planner mandates `upgrade → sync → repair → ... → classify →
  // reconform → audit --fix`. This test pins the *external* signal of that
  // wiring: the progress UI's `[*] phase` lines, written to stderr, appear
  // in the planner's canonical order — specifically, `upgrade` (when it
  // fires) precedes `sync`. The pre-#343 order had `sync` first.
  it("dispatches steps in the planner's canonical order (upgrade before sync)", async () => {
    // Pinned packVersion below the installed CLI → upgradeAvailable=true,
    // so `upgrade` is in the plan. The base scaffold is absent → scaffold-
    // Gap=true, so `sync` is also in the plan. The planner's canonical
    // order puts upgrade first.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      `export function Button() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
    );

    // Force a TTY so the progress UI emits the per-phase markers we
    // observe to assert order. Non-TTY suppresses the spinner; the order
    // would still be planner-driven but unobservable from outside.
    const origTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    try {
      const r = await runCli(["heal"], { cwd: dir });
      expect(r.code).toBe(0);

      // Both phases fire — the fixture has work for each.
      const upgradeIdx = r.stderr.search(/\bupgrade\b/);
      const syncIdx = r.stderr.search(/\bsync\b/);
      expect(upgradeIdx).toBeGreaterThanOrEqual(0);
      expect(syncIdx).toBeGreaterThanOrEqual(0);

      // Planner order: upgrade BEFORE sync. The pre-#343 hardcoded order
      // ran sync first; this assertion is the regression seam against a
      // future change that re-introduces a second ordering brain.
      expect(upgradeIdx).toBeLessThan(syncIdx);
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: origTTY,
        writable: true,
        configurable: true,
      });
    }
  }, 30000);

  // Regression guard for the #343 lingering-signal convergence check.
  //
  // ADR-0018 added `stable + 0 pending = converged` to catch the #300 shape:
  // upgrade fires forever because `upgradeCmd`'s no-chain branch can't bump
  // the pin, but no findings remain. Without the check heal would hit the
  // ceiling on a project that is in fact clean.
  //
  // The trap that check has to avoid: an unfixable finding the iteration's
  // plan member can't address (e.g. DRIFT-PATTERN-NO-SLOTS — fixable:false,
  // classify has no fixer for it) lingers like the upgrade signal *but* the
  // findings-side state still has work. Pre-#343 heal hit the ceiling and
  // exited 1, surfacing the finding. A naive `stable + 0 pending` accepted
  // it as convergence and exited 0 with a "0 findings" message — directly
  // contradicting what `claude-ds audit` would print the next second.
  //
  // Heal must gate convergence on the deriver's findings-side booleans:
  // if classify/audit work remains (because the dispatcher could not clear
  // it), it is NOT a fixed point.
  it("does not silently converge when unfixable findings remain (#343)", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: `v${pkg.version}` }),
    );
    await mkdir(join(dir, "design-system/patterns"), { recursive: true });
    // DRIFT-PATTERN-NO-SLOTS: pattern-tier file without children/slots. The
    // rule is fixable:false; classify does not relocate it (it also fires
    // DRIFT-MISPLACED but the file is structurally a leaf, so even classify's
    // tier-move heuristic can't pick a destination automatically). Heal can
    // never clear this without operator input — exit 1 (did not converge) is
    // the correct surfacing.
    await writeFile(
      join(dir, "design-system/patterns/no-slots.tsx"),
      `export function NoSlots() { return <div/>; }\nexport const meta = { kind: "pattern" as const, examples: [] };\n`,
    );

    const r = await runCli(["heal", "--max-iterations", "3"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/did not converge/);
    // The lying happy path the fix prevents: a "0 findings" convergence
    // message paired with non-zero `audit` output. Pin both signals.
    expect(r.stdout).not.toMatch(/converged in \d+ iteration\(s\) — 0 changes, 0 findings/);
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

  // PRD #325 / sub-issue #328 — resumability hint.
  //
  // Heal is convergent and idempotent (the loop's whole point — #265), so a
  // mid-run Ctrl-C and re-invocation is safe: the next invocation walks the
  // same fixed-point and picks up where it left off. The hint surfaces that
  // guarantee at the only moment a user might worry about it: when the loop
  // is running and they're tempted to wait it out.
  //
  // TTY only — agent runs (non-TTY) get no decoration. The test toggles
  // stdout.isTTY around runCli; restore in finally so the test runner's own
  // reporter doesn't break.
  describe("resumability hint (TTY only)", () => {
    it("TTY: prints 'Ctrl-C and re-run is safe'", async () => {
      await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await writeFile(
        join(dir, "design-system/atoms/button.tsx"),
        `export function Button() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      );

      const origTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });
      try {
        const r = await runCli(["heal"], { cwd: dir });
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/Ctrl-C and re-run is safe/);
      } finally {
        Object.defineProperty(process.stdout, "isTTY", {
          value: origTTY,
          writable: true,
          configurable: true,
        });
      }
    }, 15000);

    it("non-TTY (agent run): the hint is suppressed — output is unchanged from today", async () => {
      await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
      await mkdir(join(dir, "design-system/atoms"), { recursive: true });
      await writeFile(
        join(dir, "design-system/atoms/button.tsx"),
        `export function Button() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      );

      const origTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        writable: true,
        configurable: true,
      });
      try {
        const r = await runCli(["heal"], { cwd: dir });
        expect(r.code).toBe(0);
        expect(r.stdout).not.toMatch(/Ctrl-C and re-run is safe/);
      } finally {
        Object.defineProperty(process.stdout, "isTTY", {
          value: origTTY,
          writable: true,
          configurable: true,
        });
      }
    }, 15000);
  });

  // PRD #325 sub-issue #333 — headless heal collects Pending decisions and
  // exits with an --answers scaffold rather than halting on the first or
  // silently guessing. The loop converges everything Automatable to a partial
  // fixed point ("converged-modulo-Pending"), gathers unresolved Ambiguities,
  // and exits with a stable named non-zero code distinct from convergence-
  // failure so sandcastle automation can route on it specifically.
  describe("headless Pending-decision collection (sub-issue #333)", () => {
    const PENDING_EXIT = 3;
    const SCAFFOLD_FILE = ".claude-ds-pending-answers.json";

    // Equidistant-token fixture: `padding: 12` is exactly between `spacing-2`
    // (8) and `spacing-4` (16), so the DRIFT-INLINE-STATIC-STYLE fixer's
    // `describeDecisions` enumerates a `token-tie:padding:12` Ambiguity. In
    // non-TTY with no --answers, the agent must NOT silently pick a default
    // — this is exactly the project judgment ADR-0016 preserved for Collin.
    async function scaffoldEquidistantTokenFixture(): Promise<void> {
      await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
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
    }

    it("exits with a named non-zero distinct from convergence-failure", async () => {
      // Convergence-failure exit is 1; user-error is 2; the Pending-decision
      // exit must be a third stable code (3) so sandcastle automation can
      // route on it specifically rather than conflating "needs Collin" with
      // "did not converge."
      await scaffoldEquidistantTokenFixture();
      const r = await runCli(["heal"], { cwd: dir });
      expect(r.code).toBe(PENDING_EXIT);
      expect(r.code).not.toBe(0);
      expect(r.code).not.toBe(1);
      expect(r.code).not.toBe(2);
    }, 30000);

    it("the report names each Pending decision by id, restates the question, and lists options", async () => {
      await scaffoldEquidistantTokenFixture();
      const r = await runCli(["heal"], { cwd: dir });
      expect(r.code).toBe(PENDING_EXIT);
      // The Decision id is the spine-flat key the operator types into the
      // scaffold. It must appear verbatim or `--answers` can't refer to it.
      const expectedId =
        "DRIFT-INLINE-STATIC-STYLE:design-system/atoms/card.tsx::token-tie:padding:12";
      const combined = r.stdout + r.stderr;
      expect(combined).toContain(expectedId);
      // Plain-language restatement of the question — no rule-ID jargon
      // pretending to be a question. The fixer's `describeDecisions` for
      // this rule uses generic "(nearest token A/B)" labels because the
      // actual token names require reading tokens.json (I/O — banned in
      // describeDecisions), but the question itself carries the prop/value
      // pair and the word "equidistant," which is what the operator reads.
      expect(combined).toMatch(/equidistant/i);
      expect(combined).toMatch(/padding/);
      // Both options enumerated so the operator can choose without
      // re-reading the source — the failure mode is "you know there's a
      // decision but can't find the choices."
      expect(combined).toMatch(/\[0\]/);
      expect(combined).toMatch(/\[1\]/);
      // The closing summary names the count + how to act on it.
      expect(combined).toMatch(/1 decision.*need.*you/i);
      expect(combined).toMatch(/--answers/);
    }, 30000);

    it("writes an --answers scaffold file the resolver's loader can parse", async () => {
      // Acceptance #3 — the scaffold is the round-trip handoff between heal
      // and the operator. One entry per Pending decision; the value carries a
      // hint with the option indices so the user can fill it without
      // cross-referencing the report.
      await scaffoldEquidistantTokenFixture();
      const r = await runCli(["heal"], { cwd: dir });
      expect(r.code).toBe(PENDING_EXIT);

      const scaffoldPath = join(dir, SCAFFOLD_FILE);
      expect(await fileExists(scaffoldPath)).toBe(true);

      const parsed = JSON.parse(await readFile(scaffoldPath, "utf8"));
      const expectedId =
        "DRIFT-INLINE-STATIC-STYLE:design-system/atoms/card.tsx::token-tie:padding:12";
      expect(parsed).toHaveProperty(expectedId);
      const hint = parsed[expectedId];
      // The scaffold value is a sentinel string the loader rejects (`number`
      // or `"defer"` only), so a user who passes back the unedited scaffold
      // gets a clear "fill these in first" error rather than silently no-
      // op'ing. The hint enumerates the option indices so the user picks one.
      expect(typeof hint).toBe("string");
      expect(hint).toMatch(/^FILL: /);
      expect(hint).toMatch(/0=/);
      expect(hint).toMatch(/1=/);

      // Shape: flat top-level object keyed by Decision id. The existing
      // loader (`loadAnswersFile`) requires this shape; we assert it here so
      // a regression that nests answers under a wrapper key surfaces before
      // the round-trip test below.
      expect(typeof parsed).toBe("object");
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
    }, 30000);

    it("re-running with --answers <scaffold-filled> resolves the Pending decision and converges", async () => {
      // Acceptance #4 — the spine round trip. Heal exits with Pending, the
      // operator fills the scaffold value (replacing the FILL: hint string
      // with the chosen option index), and re-running converges.
      await scaffoldEquidistantTokenFixture();
      const firstRun = await runCli(["heal"], { cwd: dir });
      expect(firstRun.code).toBe(PENDING_EXIT);

      const scaffoldPath = join(dir, SCAFFOLD_FILE);
      const scaffold = JSON.parse(await readFile(scaffoldPath, "utf8"));
      const decisionId =
        "DRIFT-INLINE-STATIC-STYLE:design-system/atoms/card.tsx::token-tie:padding:12";
      // Fill the hint with option 0 (spacing-2).
      scaffold[decisionId] = 0;
      await writeFile(scaffoldPath, JSON.stringify(scaffold));

      const secondRun = await runCli(
        ["heal", "--answers", scaffoldPath],
        { cwd: dir },
      );
      expect(secondRun.code).toBe(0);
      expect(secondRun.stdout).toMatch(/converged/);

      // The fix actually ran: padding: 12 → spacing-2 (className with token).
      const card = await readFile(
        join(dir, "design-system/atoms/card.tsx"),
        "utf8",
      );
      expect(card).not.toContain("padding: 12");
    }, 60000);

    it("recognizes the partial fixed point: stable bytes + only Pending remain → exits clean (not 'did not converge')", async () => {
      // Acceptance #6 — without Pending-collection the loop would either halt
      // on the first Ambiguity (old fail-loud) or churn until the iteration
      // ceiling reporting `did not converge`. The named PENDING exit asserts
      // we hit the partial-fixed-point branch, not the ceiling-failure branch.
      await scaffoldEquidistantTokenFixture();
      const r = await runCli(["heal"], { cwd: dir });
      expect(r.code).toBe(PENDING_EXIT);
      expect(r.stderr).not.toMatch(/did not converge/);
    }, 30000);
  });
});
