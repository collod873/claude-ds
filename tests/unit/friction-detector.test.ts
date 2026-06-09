/**
 * PRD #439 — friction detector unit tests.
 *
 * The friction detector is the primary unit-test target. It is a pure scan
 * over captured rendered terminal output (pure module, crafted payloads).
 * Every rule gets a POSITIVE case (friction
 * present ⇒ a finding) and a NEGATIVE case (clean output ⇒ no finding), plus a
 * regression block built from VERBATIM real-Crewops-style output that
 * motivated the rules.
 *
 * Tests assert EXTERNAL behavior — the finding set (`kind`s and presence) —
 * never internal data structures or private helpers, per the PRD's testing
 * decisions.
 */
import { describe, it, expect } from "vitest";
import {
  scanFriction,
  type CapturedStep,
  type FrictionKind,
  type NextStepRunResult,
} from "../../src/lib/friction-detector.js";

/** Build a captured step from text; `combined` defaults to stdout. */
function step(over: Partial<CapturedStep> & { name: string }): CapturedStep {
  const stdout = over.stdout ?? "";
  const stderr = over.stderr ?? "";
  return {
    name: over.name,
    command: over.command ?? over.name,
    exitCode: over.exitCode ?? 0,
    stdout,
    stderr,
    combined: over.combined ?? `${stdout}${stderr}`,
  };
}

/** Convenience: the set of kinds present in a finding list. */
function kinds(captured: Parameters<typeof scanFriction>[0], ctx = {}): FrictionKind[] {
  return scanFriction(captured, ctx).map(f => f.kind);
}

// ---------------------------------------------------------------------------
// Rule 1: self-contradiction
// ---------------------------------------------------------------------------
describe("self-contradiction", () => {
  it("flags one file reported as both missing and already-having a thing", () => {
    const s = step({
      name: "audit",
      stdout: [
        "Button.tsx is missing a role contract",
        "Button.tsx already has a role contract",
      ].join("\n"),
    });
    expect(kinds(s)).toContain("self-contradiction");
  });

  it("stays silent when each file gets one consistent verdict", () => {
    const s = step({
      name: "audit",
      stdout: [
        "Button.tsx is missing a role contract",
        "Card.tsx already has a role contract",
      ].join("\n"),
    });
    expect(kinds(s)).not.toContain("self-contradiction");
  });
});

// ---------------------------------------------------------------------------
// Rule 2: repetition
// ---------------------------------------------------------------------------
describe("repetition", () => {
  it("flags a wall of near-identical lines that differ only by filename", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `  drift: token swap needed in src/atoms/Atom${i}.tsx`);
    const s = step({ name: "audit", stdout: lines.join("\n") });
    expect(kinds(s, { jargonAllowlist: ["drift"] })).toContain("repetition");
  });

  it("stays silent for a handful of distinct summary lines", () => {
    const s = step({
      name: "audit",
      stdout: ["fixed 3 files", "deferred 1 file", "all clean"].join("\n"),
    });
    expect(kinds(s)).not.toContain("repetition");
  });
});

// ---------------------------------------------------------------------------
// Rule 3: convergence-dishonest
// ---------------------------------------------------------------------------
describe("convergence-dishonest", () => {
  it("flags a bare 'still need attention' with no pass/fixed/deferred/reason", () => {
    const s = step({
      name: "heal",
      stdout: "Some findings still need attention.",
    });
    expect(kinds(s)).toContain("convergence-dishonest");
  });

  it("stays silent when the non-converged report is fully honest", () => {
    const s = step({
      name: "heal",
      stdout: [
        "Ran 3 passes. Fixed 0, deferred 4.",
        "Some findings still need attention because the role they require cannot be inferred automatically.",
      ].join("\n"),
    });
    expect(kinds(s)).not.toContain("convergence-dishonest");
  });
});

// ---------------------------------------------------------------------------
// Rule 4: next-step-dead-end (injected runner)
// ---------------------------------------------------------------------------
describe("next-step-dead-end", () => {
  const liveRunner = (): NextStepRunResult => ({ changedState: true, refused: false });
  const deadRunner = (): NextStepRunResult => ({ changedState: false, refused: false });
  const refuseRunner = (): NextStepRunResult => ({ changedState: false, refused: true });

  it("flags a Next: suggestion that changes nothing", () => {
    const s = step({ name: "doctor", stdout: "→ Next: run npx claude-ds audit --fix" });
    expect(kinds(s, { runner: deadRunner })).toContain("next-step-dead-end");
  });

  it("flags a Next: suggestion the command refuses", () => {
    const s = step({ name: "sync", stdout: "→ Next: run npx claude-ds heal" });
    expect(kinds(s, { runner: refuseRunner })).toContain("next-step-dead-end");
  });

  it("stays silent when the suggested command changes state", () => {
    const s = step({ name: "doctor", stdout: "→ Next: run npx claude-ds audit --fix" });
    expect(kinds(s, { runner: liveRunner })).not.toContain("next-step-dead-end");
  });

  it("is skipped (pure, no I/O) when no runner is injected", () => {
    const s = step({ name: "doctor", stdout: "→ Next: run npx claude-ds audit --fix" });
    expect(kinds(s)).not.toContain("next-step-dead-end");
  });
});

// ---------------------------------------------------------------------------
// Rule 5: jargon-unglossed
// ---------------------------------------------------------------------------
describe("jargon-unglossed", () => {
  it("flags a bare banned term with no inline gloss", () => {
    const s = step({ name: "audit", stdout: "4 files have drift." });
    expect(kinds(s)).toContain("jargon-unglossed");
  });

  it("stays silent when the term carries an inline plain-language gloss", () => {
    const s = step({
      name: "audit",
      stdout: "4 files have drift (their design tokens no longer match the shared source).",
    });
    expect(kinds(s)).not.toContain("jargon-unglossed");
  });

  it("stays silent when the term is in the consumer allowlist", () => {
    const s = step({ name: "audit", stdout: "4 files have drift." });
    expect(kinds(s, { jargonAllowlist: ["drift"] })).not.toContain("jargon-unglossed");
  });
});

// ---------------------------------------------------------------------------
// Rule 6: self-block
// ---------------------------------------------------------------------------
describe("self-block", () => {
  it("flags sync dirtying the tree then suggesting heal (which refuses on dirty)", () => {
    const s = step({
      name: "sync",
      stdout: ["Modified 6 files in design-system/.", "→ Next: run npx claude-ds heal"].join("\n"),
    });
    expect(kinds(s)).toContain("self-block");
  });

  it("stays silent when sync makes no changes before suggesting heal", () => {
    const s = step({
      name: "sync",
      stdout: ["Nothing to sync; tree already current.", "→ Next: run npx claude-ds heal"].join("\n"),
    });
    expect(kinds(s)).not.toContain("self-block");
  });
});

// ---------------------------------------------------------------------------
// Negative: fully clean run produces no findings at all
// ---------------------------------------------------------------------------
describe("clean run", () => {
  it("produces zero findings on healthy output", () => {
    const steps = [
      step({ name: "doctor", stdout: "Everything is in order. Verdict: clean." }),
      step({ name: "heal", stdout: "Ran 1 pass. Fixed 0, deferred 0. Nothing to do." }),
    ];
    expect(scanFriction(steps)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: VERBATIM real-captured output.
//
// The repetition wall below is the EXACT heal output the friction gate captures
// when a brownfield tree carries many unclassified atoms — copied verbatim from
// tests/e2e/golden/01-heal.txt (the gate's injectBrownfieldSurface plants 15
// kind-less atoms; heal's fixer adds meta.kind to each, one line per file). This
// is the one rule that genuinely reproduces against the real CLI, so its fixture
// is real bytes, not a synthetic reconstruction (PRD #443). Tracked in
// friction-baseline.json; removal trigger is the collapse-to-count fix (#448).
//
// The surrounding self-contradiction / convergence / jargon / next-step shapes
// stay crafted — those rules are regression guards (self-contradiction is fixed,
// convergence-dishonest is a near-dead defensive branch), so the unit test pins
// the rule behavior while the gate owns the real-output coverage.
// ---------------------------------------------------------------------------
describe("regression: real-captured wall of friction", () => {
  // Verbatim from tests/e2e/golden/01-heal.txt — the per-file fixer lines that
  // trip the repetition rule (16 lines > REPETITION_THRESHOLD of 12).
  const realHealWall = [
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/IconLabel.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified01.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified02.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified03.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified04.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified05.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified06.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified07.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified08.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified09.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified10.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified11.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified12.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified13.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified14.tsx`,
    `fixed [DRIFT-META-KIND-MISSING]: added meta.kind = "atom" to design-system/atoms/Unclassified15.tsx`,
  ].join("\n");

  // The real captured wall, in a heal step — this is the rule that reproduces.
  const healStep = step({
    name: "heal",
    stdout: [
      "heal: pass 1/3 — audit --fix",
      realHealWall,
      "fix summary: 16 fixed, 0 deferred",
    ].join("\n"),
  });

  // Crafted shapes for the guard rules: self-contradiction (a path with both
  // verdicts — also a bare, unglossed `meta.kind` ⇒ jargon), dishonest
  // convergence, and a dead-end / self-blocking next-step.
  const auditStep = step({
    name: "audit",
    stdout: [
      "Auditing design-system…",
      "src/components/Button.tsx is missing meta.kind",
      "src/components/Button.tsx already has meta.kind",
      "Some findings still need attention.",
      "→ Next: run npx claude-ds heal",
    ].join("\n"),
  });

  const syncStep = step({
    name: "sync",
    stdout: ["Updated 12 files in design-system/.", "→ Next: run npx claude-ds heal"].join("\n"),
  });

  it("surfaces every graded friction kind from the captured + crafted output", () => {
    const found = new Set(scanFriction([syncStep, auditStep, healStep]).map(f => f.kind));
    expect(found).toContain("self-contradiction");
    expect(found).toContain("repetition");
    expect(found).toContain("convergence-dishonest");
    expect(found).toContain("jargon-unglossed");
    expect(found).toContain("self-block");
  });

  it("the repetition finding is the real captured heal wall", () => {
    const rep = scanFriction([healStep]).filter(f => f.kind === "repetition");
    expect(rep).toHaveLength(1);
    // The normalized key strips the per-file token, matching the gate's key.
    expect(rep[0].key).toBe(
      `repetition:heal:fixed [DRIFT-META-KIND-MISSING]: added <file> = "atom" to <path>`,
    );
  });

  it("produces stable keys so the baseline ratchet can match findings across runs", () => {
    const keysA = scanFriction([syncStep, auditStep, healStep]).map(f => f.key).sort();
    const keysB = scanFriction([syncStep, auditStep, healStep]).map(f => f.key).sort();
    expect(keysA).toEqual(keysB);
    // The self-contradiction key carries the offending path so it is
    // human-traceable and unique per file.
    expect(keysA.some(k => k.startsWith("self-contradiction:") && k.includes("Button.tsx"))).toBe(
      true,
    );
  });

  it("dead-end next-step fires against a post-run tree where heal refuses (dirty tree)", () => {
    // Injected runner models real Crewops: heal refuses on the dirty tree sync
    // just created. The liveness rule and the self-block rule both fire.
    const runner = (cmd: string): NextStepRunResult =>
      /heal/.test(cmd)
        ? { changedState: false, refused: true, note: "dirty tree" }
        : { changedState: true, refused: false };
    const found = new Set(scanFriction([syncStep, auditStep], { runner }).map(f => f.kind));
    expect(found).toContain("next-step-dead-end");
  });
});
