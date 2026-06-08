/**
 * Issue #416 (repurposed by PRD #439) — Crewops snapshot-staleness
 * tripwire unit tests.
 *
 * The tripwire compares two `doctor --json` payloads (or two
 * `heal --dry-run --json` payloads): one captured against the committed
 * Crewops snapshot (`tests/e2e/fixtures/crewops-snapshot/`, the tree the
 * deterministic PR friction gate runs against), one captured against live
 * Crewops. When they disagree — live Crewops's verdict diverges from the
 * committed snapshot's — the snapshot has gone STALE and a fixture-refresh
 * issue is auto-filed. It runs daily-only and never gates a PR.
 *
 * The detection itself is pure: feed two JSON envelopes, get a
 * `DivergenceReport` back. The workflow shim that fires the report calls
 * `gh issue create` with the body this module builds.
 */
import { describe, it, expect } from "vitest";
import {
  detectDivergence,
  buildTripwireIssueBody,
  TRIPWIRE_MARKER,
  TRIPWIRE_LABEL,
  type HeadlessDoctorEnvelope,
} from "../../src/lib/crewops-tripwire.js";

function envelope(over: Partial<HeadlessDoctorEnvelope> = {}): HeadlessDoctorEnvelope {
  return {
    command: "doctor",
    ok: true,
    verdict: "clean",
    exitCode: 0,
    actions: {},
    remaining: {
      missingManaged: [],
      lookalikes: 0,
      rootDupes: 0,
      repairNeeded: 0,
      upgradeAvailable: false,
      openExceptions: 0,
    },
    ...over,
  };
}

describe("detectDivergence", () => {
  it("returns ok=true when snapshot and live outputs agree on verdict", () => {
    const snapshot = envelope({ verdict: "clean", ok: true });
    const real = envelope({ verdict: "clean", ok: true });
    const r = detectDivergence({ snapshot, real });
    expect(r.ok).toBe(true);
    expect(r.reasons).toHaveLength(0);
  });

  it("flags a verdict mismatch (the central staleness signal)", () => {
    // Snapshot says clean, live Crewops fails — the committed snapshot is stale.
    const snapshot = envelope({ verdict: "clean", ok: true });
    const real = envelope({ verdict: "scaffold-gap", ok: false, exitCode: 1 });
    const r = detectDivergence({ snapshot, real });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/verdict/i);
  });

  it("flags an ok mismatch even when the verdict label coincidentally matches", () => {
    const snapshot = envelope({ ok: true, verdict: "clean" });
    const real = envelope({ ok: false, verdict: "clean" });
    const r = detectDivergence({ snapshot, real });
    expect(r.ok).toBe(false);
  });

  it("flags a remaining.missingManaged divergence", () => {
    const snapshot = envelope({
      remaining: { ...envelope().remaining, missingManaged: [] },
    });
    const real = envelope({
      ok: false,
      verdict: "scaffold-gap",
      remaining: {
        ...envelope().remaining,
        missingManaged: ["design-system/contracts/role-contracts.test.tsx"],
      },
    });
    const r = detectDivergence({ snapshot, real });
    expect(r.ok).toBe(false);
    expect(r.reasons.some(r => r.includes("missingManaged"))).toBe(true);
  });

  it("flags a repairNeeded divergence", () => {
    const snapshot = envelope({ remaining: { ...envelope().remaining, repairNeeded: 0 } });
    const real = envelope({
      ok: false,
      verdict: "repair-needed",
      remaining: { ...envelope().remaining, repairNeeded: 4 },
    });
    const r = detectDivergence({ snapshot, real });
    expect(r.ok).toBe(false);
    expect(r.reasons.some(r => r.includes("repairNeeded"))).toBe(true);
  });

  it("names both sides in a divergence reason so the maintainer can read the drift", () => {
    const snapshot = envelope({ verdict: "clean" });
    const real = envelope({ verdict: "scaffold-gap", ok: false });
    const r = detectDivergence({ snapshot, real });
    expect(r.reasons.join(" ")).toContain("snapshot=clean");
    expect(r.reasons.join(" ")).toContain("real=scaffold-gap");
  });

  it("tolerates upgradeAvailable diverging (CLI version moves independently of the snapshot content)", () => {
    // The snapshot's pinned packVersion is committed; live Crewops's may
    // simply be older. That's not a snapshot-staleness signal — it's a real-
    // project pin decision. We deliberately ignore that single field.
    const snapshot = envelope({
      remaining: { ...envelope().remaining, upgradeAvailable: false },
    });
    const real = envelope({
      remaining: { ...envelope().remaining, upgradeAvailable: true },
    });
    const r = detectDivergence({ snapshot, real });
    expect(r.ok).toBe(true);
  });
});

describe("buildTripwireIssueBody", () => {
  it("carries the tripwire marker and label hint", () => {
    const body = buildTripwireIssueBody({
      snapshot: envelope({ verdict: "clean" }),
      real: envelope({ verdict: "scaffold-gap", ok: false }),
      reasons: ["verdict mismatch: snapshot=clean real=scaffold-gap"],
      runUrl: "https://x/run/1",
    });
    expect(body).toContain(TRIPWIRE_MARKER);
    expect(body).toContain("fixture-refresh");
  });

  it("includes the divergence reasons verbatim so the maintainer can diagnose without re-running", () => {
    const body = buildTripwireIssueBody({
      snapshot: envelope({}),
      real: envelope({ ok: false }),
      reasons: ["verdict mismatch: snapshot=clean real=scaffold-gap", "remaining.missingManaged differs"],
      runUrl: "https://x/run",
    });
    expect(body).toContain("verdict mismatch");
    expect(body).toContain("remaining.missingManaged differs");
  });

  it("names the committed snapshot fixture so the maintainer knows what went stale", () => {
    const body = buildTripwireIssueBody({
      snapshot: envelope({}),
      real: envelope({ ok: false }),
      reasons: ["x"],
      runUrl: "https://x/run",
    });
    expect(body).toContain("tests/e2e/fixtures/crewops-snapshot/");
  });

  it("points the maintainer at the documented refresh procedure", () => {
    const body = buildTripwireIssueBody({
      snapshot: envelope({}),
      real: envelope({ ok: false }),
      reasons: ["x"],
      runUrl: "https://x/run",
    });
    expect(body).toMatch(/docs\/agents\/fixture-refresh\.md/);
  });
});

describe("TRIPWIRE_LABEL", () => {
  it("is a stable, single-word label so the tripwire queue is filterable", () => {
    expect(TRIPWIRE_LABEL).toMatch(/^[a-z0-9:-]+$/);
  });
});
