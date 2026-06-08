/**
 * Issue #416 — real-Crewops tripwire unit tests.
 *
 * The tripwire compares two `doctor --json` payloads (or two
 * `heal --dry-run --json` payloads): one captured against the
 * Crewops-shaped fixture (the proxy the e2e gate runs), one
 * captured against the real Crewops project. When they disagree
 * — the real-Crewops verdict diverges from the fixture's — the
 * proxy has gone stale and a fixture-refresh issue is auto-filed.
 *
 * The detection itself is pure: feed two JSON envelopes, get a
 * `DivergenceReport` back. The workflow shim that fires the
 * report calls `gh issue create` with the body this module builds.
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
  it("returns ok=true when fixture and real outputs agree on verdict", () => {
    const fixture = envelope({ verdict: "clean", ok: true });
    const real = envelope({ verdict: "clean", ok: true });
    const r = detectDivergence({ fixture, real });
    expect(r.ok).toBe(true);
    expect(r.reasons).toHaveLength(0);
  });

  it("flags a verdict mismatch (the central tripwire signal)", () => {
    // Fixture says clean, real Crewops fails — the proxy is wrong.
    const fixture = envelope({ verdict: "clean", ok: true });
    const real = envelope({ verdict: "scaffold-gap", ok: false, exitCode: 1 });
    const r = detectDivergence({ fixture, real });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/verdict/i);
  });

  it("flags an ok mismatch even when the verdict label coincidentally matches", () => {
    const fixture = envelope({ ok: true, verdict: "clean" });
    const real = envelope({ ok: false, verdict: "clean" });
    const r = detectDivergence({ fixture, real });
    expect(r.ok).toBe(false);
  });

  it("flags a remaining.missingManaged divergence", () => {
    const fixture = envelope({
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
    const r = detectDivergence({ fixture, real });
    expect(r.ok).toBe(false);
    expect(r.reasons.some(r => r.includes("missingManaged"))).toBe(true);
  });

  it("flags a repairNeeded divergence", () => {
    const fixture = envelope({ remaining: { ...envelope().remaining, repairNeeded: 0 } });
    const real = envelope({
      ok: false,
      verdict: "repair-needed",
      remaining: { ...envelope().remaining, repairNeeded: 4 },
    });
    const r = detectDivergence({ fixture, real });
    expect(r.ok).toBe(false);
    expect(r.reasons.some(r => r.includes("repairNeeded"))).toBe(true);
  });

  it("tolerates upgradeAvailable diverging (CLI version moves independently of the fixture content)", () => {
    // The fixture's pinned packVersion is committed; the real Crewops's may
    // simply be older. That's not a fixture-staleness signal — it's a real-
    // project pin decision. We deliberately ignore that single field.
    const fixture = envelope({
      remaining: { ...envelope().remaining, upgradeAvailable: false },
    });
    const real = envelope({
      remaining: { ...envelope().remaining, upgradeAvailable: true },
    });
    const r = detectDivergence({ fixture, real });
    expect(r.ok).toBe(true);
  });
});

describe("buildTripwireIssueBody", () => {
  it("carries the tripwire marker and label hint", () => {
    const body = buildTripwireIssueBody({
      fixture: envelope({ verdict: "clean" }),
      real: envelope({ verdict: "scaffold-gap", ok: false }),
      reasons: ["verdict mismatch: fixture=clean real=scaffold-gap"],
      runUrl: "https://x/run/1",
    });
    expect(body).toContain(TRIPWIRE_MARKER);
    expect(body).toContain("fixture-refresh");
  });

  it("includes the divergence reasons verbatim so the maintainer can diagnose without re-running", () => {
    const body = buildTripwireIssueBody({
      fixture: envelope({}),
      real: envelope({ ok: false }),
      reasons: ["verdict mismatch: fixture=clean real=scaffold-gap", "remaining.missingManaged differs"],
      runUrl: "https://x/run",
    });
    expect(body).toContain("verdict mismatch");
    expect(body).toContain("remaining.missingManaged differs");
  });

  it("points the maintainer at the documented fixture-refresh procedure", () => {
    const body = buildTripwireIssueBody({
      fixture: envelope({}),
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
