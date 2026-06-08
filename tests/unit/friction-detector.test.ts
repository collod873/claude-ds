/**
 * PRD #439 — friction detector unit tests.
 *
 * The friction detector is the primary unit-test target. It is a pure scan
 * over captured rendered terminal output (mirroring `crewops-tripwire.ts`:
 * pure module, crafted payloads). Every rule gets a POSITIVE case (friction
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
// Regression: VERBATIM real-Crewops-style output.
//
// This payload mirrors the wall of friction graded in a real Crewops session:
// a self-contradicting audit, a ~90-line repetition wall, a dishonest
// convergence message, jargon with no gloss, a dead-end / self-blocking
// next-step. The assertions pin the EXTERNAL finding set, not internals.
// ---------------------------------------------------------------------------
describe("regression: real-Crewops-style wall of friction", () => {
  // Reconstructed near-verbatim from the grading session: the repetition wall.
  const wall = Array.from(
    { length: 90 },
    (_, i) => `  ⚠ meta.kind missing — needs scaffold in src/components/Component${i}.tsx`,
  ).join("\n");

  const auditStep = step({
    name: "audit",
    stdout: [
      "Auditing design-system…",
      "src/components/Button.tsx is missing meta.kind",
      "src/components/Button.tsx already has meta.kind",
      wall,
      "Some findings still need attention.",
      "→ Next: run npx claude-ds heal",
    ].join("\n"),
  });

  const syncStep = step({
    name: "sync",
    stdout: ["Updated 12 files in design-system/.", "→ Next: run npx claude-ds heal"].join("\n"),
  });

  it("surfaces every graded friction kind from the real output", () => {
    const found = new Set(scanFriction([syncStep, auditStep]).map(f => f.kind));
    expect(found).toContain("self-contradiction");
    expect(found).toContain("repetition");
    expect(found).toContain("convergence-dishonest");
    expect(found).toContain("jargon-unglossed");
    expect(found).toContain("self-block");
  });

  it("produces stable keys so the baseline ratchet can match findings across runs", () => {
    const keysA = scanFriction([syncStep, auditStep]).map(f => f.key).sort();
    const keysB = scanFriction([syncStep, auditStep]).map(f => f.key).sort();
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
