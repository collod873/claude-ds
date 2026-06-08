import { describe, it, expect } from "vitest";
import { decidePromotion, reconcileAll } from "../../scripts/reconcile-queued.mjs";

/**
 * #422 — promotion-cascade self-healing reconciler.
 *
 * The inline promotion cascade inside `agent-auto-merge.yml` is coupled to
 * a single workflow run. When that run is cancelled (as on 2026-06-08 for
 * the #408 auto-merge, hung 50min then killed under a `timeout-minutes: 5`
 * that the self-hosted runner ignored), the PR merges and the issue closes
 * but dependents stay `agent:queued` forever.
 *
 * The reconciler sweeps every open `agent:queued` issue and promotes any
 * whose blockers are all closed — independent of which run, if any, closed
 * the blocker. It is idempotent: running it on a healthy queue is a no-op.
 */

describe("decidePromotion", () => {
  it("skips when the issue is not agent:queued", () => {
    const d = decidePromotion({ labels: [], blockedBy: [] });
    expect(d.kind).toBe("skip");
    expect(d.reason).toMatch(/not agent:queued/i);
  });

  it("skips when the issue is already agent:in-progress", () => {
    const d = decidePromotion({
      labels: ["agent:queued", "agent:in-progress"],
      blockedBy: [],
    });
    expect(d.kind).toBe("skip");
    expect(d.reason).toMatch(/in-progress/i);
  });

  it("skips when at least one declared blocker is still OPEN", () => {
    const d = decidePromotion({
      labels: ["agent:queued"],
      blockedBy: [
        { number: 1, state: "CLOSED" },
        { number: 2, state: "OPEN" },
      ],
    });
    expect(d.kind).toBe("skip");
    expect(d.reason).toMatch(/1 open blocker/);
  });

  it("promotes when every blocker is closed", () => {
    const d = decidePromotion({
      labels: ["agent:queued"],
      blockedBy: [
        { number: 1, state: "CLOSED" },
        { number: 2, state: "CLOSED" },
      ],
    });
    expect(d.kind).toBe("promote");
  });

  it("promotes when there are no declared blockers at all", () => {
    const d = decidePromotion({
      labels: ["agent:queued"],
      blockedBy: [],
    });
    expect(d.kind).toBe("promote");
  });
});

type FakeIssue = {
  number: number;
  labels: string[];
  blockedBy: Array<{ number: number; state: "OPEN" | "CLOSED" }>;
};

function fakeClient(issues: FakeIssue[]): {
  client: {
    listQueuedIssues: () => Promise<number[]>;
    getIssueState: (n: number) => Promise<{
      labels: string[];
      blockedBy: Array<{ number: number; state: "OPEN" | "CLOSED" }>;
    }>;
    promote: (n: number) => Promise<void>;
  };
  promoted: number[];
} {
  const map = new Map<number, FakeIssue>();
  for (const i of issues) map.set(i.number, i);
  const promoted: number[] = [];
  const client = {
    async listQueuedIssues(): Promise<number[]> {
      return issues
        .filter((i) => i.labels.includes("agent:queued"))
        .map((i) => i.number);
    },
    async getIssueState(n: number): Promise<{
      labels: string[];
      blockedBy: Array<{ number: number; state: "OPEN" | "CLOSED" }>;
    }> {
      const it = map.get(n);
      if (!it) throw new Error(`unknown issue ${n}`);
      return { labels: it.labels, blockedBy: it.blockedBy };
    },
    async promote(n: number): Promise<void> {
      promoted.push(n);
      const it = map.get(n);
      if (!it) return;
      it.labels = it.labels.filter((l) => l !== "agent:queued").concat("agent:implement");
    },
  };
  return { client, promoted };
}

describe("reconcileAll", () => {
  it("promotes the regression scenario: cascade was cancelled but blockers are all closed", async () => {
    // #408 was the last blocker for #410, #412, #413, #414. The auto-merge run
    // that closed #408 was cancelled before the inline cascade ran. They should
    // all be promoted on the next reconciler sweep.
    const issues: FakeIssue[] = [
      { number: 410, labels: ["agent:queued"], blockedBy: [{ number: 408, state: "CLOSED" }] },
      { number: 412, labels: ["agent:queued"], blockedBy: [{ number: 408, state: "CLOSED" }] },
      { number: 413, labels: ["agent:queued"], blockedBy: [{ number: 408, state: "CLOSED" }] },
      { number: 414, labels: ["agent:queued"], blockedBy: [{ number: 408, state: "CLOSED" }] },
    ];
    const { client, promoted } = fakeClient(issues);
    const report = await reconcileAll(client);
    expect(promoted.sort()).toEqual([410, 412, 413, 414]);
    expect(report.promoted.sort()).toEqual([410, 412, 413, 414]);
    expect(report.skipped).toHaveLength(0);
  });

  it("idempotent: a second sweep on a healthy queue promotes nothing", async () => {
    const issues: FakeIssue[] = [
      { number: 410, labels: ["agent:queued"], blockedBy: [{ number: 408, state: "CLOSED" }] },
    ];
    const { client } = fakeClient(issues);
    await reconcileAll(client);
    const { client: c2, promoted: p2 } = fakeClient(issues);
    const report = await reconcileAll(c2);
    expect(p2).toEqual([]);
    expect(report.promoted).toEqual([]);
  });

  it("does not promote an issue with an open blocker", async () => {
    const issues: FakeIssue[] = [
      {
        number: 415,
        labels: ["agent:queued"],
        blockedBy: [
          { number: 410, state: "OPEN" },
          { number: 408, state: "CLOSED" },
        ],
      },
    ];
    const { client, promoted } = fakeClient(issues);
    const report = await reconcileAll(client);
    expect(promoted).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toMatch(/open blocker/);
  });

  it("does not promote an issue already in agent:in-progress", async () => {
    const issues: FakeIssue[] = [
      {
        number: 415,
        labels: ["agent:queued", "agent:in-progress"],
        blockedBy: [{ number: 408, state: "CLOSED" }],
      },
    ];
    const { client, promoted } = fakeClient(issues);
    const report = await reconcileAll(client);
    expect(promoted).toEqual([]);
    expect(report.skipped[0].reason).toMatch(/in-progress/);
  });
});
