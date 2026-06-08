/**
 * Issue #412 — the shared CLI-version vs pack-pin vocabulary.
 *
 * Pure pin against the headline helper that the front-door / heal gate header
 * and `upgrade` both consume. The whole point of routing through this helper
 * is so the `pack X → Y` phantom (rendered when a stale pin has zero
 * registered migrations) cannot recur.
 */
import { describe, it, expect } from "vitest";
import { upgradeHeadline, cliVersion, LABEL_CLI, LABEL_PIN, LABEL_PACK } from "../../src/lib/version-vocab";
import pkg from "../../package.json" with { type: "json" };

describe("upgradeHeadline", () => {
  it("from === to: 'verify migration end-states' (no phantom pack X→Y)", () => {
    expect(upgradeHeadline({ from: "v1.0.0", to: "v1.0.0", chainLength: 0 })).toBe(
      "verify migration end-states",
    );
  });

  it("stale pin, empty chain: 'pin bump only — pack stays vX' (no phantom)", () => {
    // The Crewops scenario: pinned at v1.0.0, CLI at v1.4.0, but no migrations
    // registered for that gap. Pre-#412 the gate header read `pack v1.0.0 →
    // v1.4.0` while the body said `pack is at v1.0.0` — contradiction.
    expect(upgradeHeadline({ from: "v1.0.0", to: "v1.4.0", chainLength: 0 })).toBe(
      "pin bump only — pack stays v1.0.0",
    );
  });

  it("stale pin, non-empty chain: 'pack X → Y' (the real migration case)", () => {
    expect(upgradeHeadline({ from: "v0.7.0", to: "v0.9.0", chainLength: 2 })).toBe(
      "pack v0.7.0 → v0.9.0",
    );
  });
});

describe("cliVersion / labels", () => {
  it("cliVersion mirrors package.json", () => {
    expect(cliVersion()).toBe(`v${pkg.version}`);
  });

  it("labels are stable strings every surface consumes", () => {
    expect(LABEL_CLI).toBe("installed");
    expect(LABEL_PIN).toBe("pinned");
    expect(LABEL_PACK).toBe("pack");
  });
});
