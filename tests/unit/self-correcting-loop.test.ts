/**
 * Issue #416 — self-correcting loop unit tests.
 *
 * The loop itself is pure: takes a failing e2e harness output + the
 * offending assertion + history of prior auto-filed issues, and returns
 * a decision (file single issue, escalate to PRD, stop and escalate to
 * Collin). Network I/O happens only at the call site that consumes the
 * decision — these tests pin the decision logic in isolation.
 */
import { describe, it, expect } from "vitest";
import {
  failureSignature,
  decideEscalation,
  buildIssueBody,
  buildPrdBody,
  AUTO_FILED_MARKER,
  AUTO_FILED_LABEL,
  type HarnessFailure,
  type OpenAutoFiledIssue,
} from "../../src/lib/self-correcting-loop.js";

function failure(partial: Partial<HarnessFailure> = {}): HarnessFailure {
  return {
    category: "duplicate-meta-decl",
    assertion: "expect(duplicateMeta).toHaveLength(0)",
    file: "design-system/atoms/Button.tsx",
    detail: "2 export const meta declarations in one file",
    evidence: "export const meta / export const meta",
    runUrl: "https://github.com/o/r/actions/runs/1",
    ...partial,
  };
}

describe("failureSignature", () => {
  it("is stable across runs of the same failure", () => {
    const a = failureSignature(failure());
    const b = failureSignature(failure());
    expect(a).toBe(b);
  });

  it("ignores per-run noise (runUrl, evidence text)", () => {
    const a = failureSignature(failure({ runUrl: "https://x/1", evidence: "x" }));
    const b = failureSignature(failure({ runUrl: "https://x/2", evidence: "y" }));
    expect(a).toBe(b);
  });

  it("changes when the category changes", () => {
    const a = failureSignature(failure({ category: "duplicate-meta-decl" }));
    const b = failureSignature(failure({ category: "consumer-tsc-error" }));
    expect(a).not.toBe(b);
  });

  it("changes when the file changes", () => {
    const a = failureSignature(failure({ file: "design-system/atoms/A.tsx" }));
    const b = failureSignature(failure({ file: "design-system/atoms/B.tsx" }));
    expect(a).not.toBe(b);
  });

  it("changes when the assertion changes", () => {
    const a = failureSignature(failure({ assertion: "expect(x).toBe(0)" }));
    const b = failureSignature(failure({ assertion: "expect(y).toBe(0)" }));
    expect(a).not.toBe(b);
  });
});

describe("decideEscalation", () => {
  const empty: OpenAutoFiledIssue[] = [];

  it("files a single issue for a single isolated failure", () => {
    const decision = decideEscalation({
      failures: [failure()],
      openAutoFiled: empty,
      consecutiveUnproductiveRounds: 0,
    });
    expect(decision.kind).toBe("file-issue");
    if (decision.kind !== "file-issue") throw new Error("expected file-issue");
    expect(decision.failure.category).toBe("duplicate-meta-decl");
    expect(decision.signature).toBe(failureSignature(failure()));
  });

  it("escalates to PRD on clustered failures (>=3 distinct categories)", () => {
    const decision = decideEscalation({
      failures: [
        failure({ category: "duplicate-meta-decl" }),
        failure({ category: "consumer-tsc-error", file: "a.ts" }),
        failure({ category: "missing-managed-file", file: "b" }),
      ],
      openAutoFiled: empty,
      consecutiveUnproductiveRounds: 0,
    });
    expect(decision.kind).toBe("file-prd");
    if (decision.kind !== "file-prd") throw new Error("expected file-prd");
    expect(decision.failures).toHaveLength(3);
  });

  it("escalates to PRD when a failure is explicitly judged structural", () => {
    const decision = decideEscalation({
      failures: [failure({ structural: true })],
      openAutoFiled: empty,
      consecutiveUnproductiveRounds: 0,
    });
    expect(decision.kind).toBe("file-prd");
  });

  it("dedupes against an open auto-filed issue with the same signature", () => {
    const f = failure();
    const sig = failureSignature(f);
    const decision = decideEscalation({
      failures: [f],
      openAutoFiled: [{ number: 99, signatures: [sig], structural: false }],
      consecutiveUnproductiveRounds: 0,
    });
    expect(decision.kind).toBe("skip-duplicate");
    if (decision.kind !== "skip-duplicate") throw new Error("expected skip-duplicate");
    expect(decision.existingIssue).toBe(99);
  });

  it("after N=2 unproductive rounds, stops and escalates to Collin instead of filing", () => {
    const decision = decideEscalation({
      failures: [failure()],
      openAutoFiled: empty,
      consecutiveUnproductiveRounds: 2,
    });
    expect(decision.kind).toBe("escalate-collin");
    if (decision.kind !== "escalate-collin") throw new Error("expected escalate-collin");
    expect(decision.reason).toMatch(/unproductive/i);
  });

  it("respects a custom ceiling override", () => {
    const decision = decideEscalation({
      failures: [failure()],
      openAutoFiled: empty,
      consecutiveUnproductiveRounds: 1,
      ceiling: 1,
    });
    expect(decision.kind).toBe("escalate-collin");
  });

  it("no-ops when there are no failures (gate went green)", () => {
    const decision = decideEscalation({
      failures: [],
      openAutoFiled: empty,
      consecutiveUnproductiveRounds: 0,
    });
    expect(decision.kind).toBe("noop");
  });
});

describe("buildIssueBody", () => {
  it("includes the auto-filed marker so a runaway can be bulk-closed", () => {
    const body = buildIssueBody({
      failure: failure(),
      signature: "sig-abc",
      sourcePr: 123,
      runUrl: "https://example/run/1",
    });
    expect(body).toContain(AUTO_FILED_MARKER);
  });

  it("includes the failure signature so dedupe can recover it on a re-scan", () => {
    const body = buildIssueBody({
      failure: failure(),
      signature: "sig-abc",
      sourcePr: 123,
      runUrl: "https://example/run/1",
    });
    expect(body).toContain("sig-abc");
  });

  it("includes the offending assertion and the harness output evidence", () => {
    const body = buildIssueBody({
      failure: failure({ assertion: "expect(x).toEqual([])", evidence: "got [3]" }),
      signature: "sig-1",
      sourcePr: 1,
      runUrl: "https://example/run/2",
    });
    expect(body).toContain("expect(x).toEqual([])");
    expect(body).toContain("got [3]");
  });

  it("includes the source PR reference but does NOT use auto-closing keywords (Closes/Fixes/Resolves)", () => {
    // Auto-closing the source PR's #N would back-leak the failure: the loop
    // files follow-ups, it does not close the PR that caused them.
    const body = buildIssueBody({
      failure: failure(),
      signature: "sig",
      sourcePr: 415,
      runUrl: "https://example/run/3",
    });
    expect(body).toContain("415");
    expect(body).not.toMatch(/\b(closes|fixes|resolves)\s+#415\b/i);
  });
});

describe("buildPrdBody", () => {
  it("enumerates every failure in the cluster", () => {
    const body = buildPrdBody({
      failures: [
        failure({ category: "duplicate-meta-decl", file: "a.tsx" }),
        failure({ category: "consumer-tsc-error", file: "b.tsx" }),
        failure({ category: "missing-managed-file", file: "c" }),
      ],
      signatures: ["s1", "s2", "s3"],
      sourcePr: 200,
      runUrl: "https://example/run",
    });
    expect(body).toContain("a.tsx");
    expect(body).toContain("b.tsx");
    expect(body).toContain("c");
    expect(body).toContain(AUTO_FILED_MARKER);
  });
});

describe("AUTO_FILED_LABEL", () => {
  it("is a stable, single-word label so bulk-close queries can target it", () => {
    expect(AUTO_FILED_LABEL).toMatch(/^[a-z0-9:-]+$/);
  });
});
