/**
 * PRD #439 — direct unit tests for the baseline ratchet (`reconcile`).
 *
 * The ratchet policy lives in `friction-gate.ts`'s pure `reconcile()`: it diffs
 * a run's findings against the committed baseline and produces the verdict the
 * gate asserts on. The full e2e spec exercises it through the real CLI, but the
 * RATCHET LOGIC ITSELF — regression vs. accepted vs. stale — deserves a fast,
 * crafted-payload unit test that does not boot the CLI (issue #442, AC8).
 *
 * Tests assert EXTERNAL behavior — the verdict (`pass`) and the
 * `regressions` / `stale` key sets — never internals, mirroring the detector's
 * unit tests.
 */
import { describe, it, expect } from "vitest";
import {
  reconcile,
  keysMissingTriggers,
  type FrictionBaseline,
} from "../e2e/friction-gate.js";
import type { FrictionFinding } from "../../src/lib/friction-detector.js";

/** Craft a finding with a stable key; kind/message are incidental here. */
function finding(key: string): FrictionFinding {
  return { kind: "jargon-unglossed", message: `synthetic ${key}`, key };
}

/** A baseline whose keys all carry a placeholder trigger (invariant satisfied). */
function baseline(...keys: string[]): FrictionBaseline {
  return {
    keys,
    removalTriggers: Object.fromEntries(keys.map((k) => [k, `fix ${k}`])),
  };
}

describe("reconcile — the baseline ratchet", () => {
  it("(a) a finding NOT in the baseline is a regression ⇒ pass=false", () => {
    const findings = [finding("jargon-unglossed:drift")];
    const result = reconcile(findings, baseline()); // empty baseline

    expect(result.pass).toBe(false);
    expect(result.regressions.map((f) => f.key)).toEqual([
      "jargon-unglossed:drift",
    ]);
    expect(result.stale).toEqual([]);
  });

  it("(b) all findings present in the baseline ⇒ pass=true, no regressions", () => {
    const findings = [
      finding("jargon-unglossed:drift"),
      finding("jargon-unglossed:scaffold"),
    ];
    const result = reconcile(
      findings,
      baseline("jargon-unglossed:drift", "jargon-unglossed:scaffold"),
    );

    expect(result.pass).toBe(true);
    expect(result.regressions).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  it("(c) a baseline key with no matching finding is stale/removable but does NOT fail", () => {
    const findings = [finding("jargon-unglossed:drift")];
    const result = reconcile(
      findings,
      baseline("jargon-unglossed:drift", "jargon-unglossed:converge"),
    );

    expect(result.pass).toBe(true);
    expect(result.regressions).toEqual([]);
    expect(result.stale).toEqual(["jargon-unglossed:converge"]);
  });

  it("separates regressions from stale in a mixed run (regression still fails)", () => {
    const findings = [
      finding("jargon-unglossed:drift"), // accepted
      finding("jargon-unglossed:meta.kind"), // new ⇒ regression
    ];
    const result = reconcile(
      findings,
      baseline("jargon-unglossed:drift", "jargon-unglossed:converge"),
    );

    expect(result.pass).toBe(false);
    expect(result.regressions.map((f) => f.key)).toEqual([
      "jargon-unglossed:meta.kind",
    ]);
    expect(result.stale).toEqual(["jargon-unglossed:converge"]);
  });
});

describe("keysMissingTriggers — the ADR-0003 trigger invariant (#456)", () => {
  it("every key carrying a non-empty trigger ⇒ no violations", () => {
    expect(
      keysMissingTriggers(baseline("jargon-unglossed:scaffold", "self-block:sync->heal")),
    ).toEqual([]);
  });

  it("a key absent from removalTriggers is a violation", () => {
    const b: FrictionBaseline = {
      keys: ["jargon-unglossed:scaffold", "jargon-unglossed:drift"],
      removalTriggers: { "jargon-unglossed:drift": "reword drift" },
    };
    expect(keysMissingTriggers(b)).toEqual(["jargon-unglossed:scaffold"]);
  });

  it("a whitespace-only trigger counts as missing", () => {
    const b: FrictionBaseline = {
      keys: ["jargon-unglossed:scaffold"],
      removalTriggers: { "jargon-unglossed:scaffold": "   " },
    };
    expect(keysMissingTriggers(b)).toEqual(["jargon-unglossed:scaffold"]);
  });
});
