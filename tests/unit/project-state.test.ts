/**
 * Issue #343 — `deriveProjectState` is the I/O half of the shared
 * remediation planner (ADR-0018). The planner is a pure function of
 * `ProjectState`; this module folds the consumer tree into that state.
 *
 * These tests pin the state→signal mapping against representative
 * fixtures. The planner's pure ordering is tested separately
 * (`remediation-planner.test.ts`); here we assert that the booleans
 * `deriveProjectState` emits actually reflect the tree on disk, so the
 * two halves compose correctly when `heal` runs the planner on real
 * state.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freshTmpDir, cleanup } from "../helpers/tmpdir.js";
import { deriveProjectState } from "../../src/lib/project-state.js";
import { planRemediation } from "../../src/lib/remediation-planner.js";
import pkg from "../../package.json" with { type: "json" };

const BASE_CFG = {
  pack: "next-react",
  mode: "warn",
  domain_roots: ["features", "lib"],
  ds_aliases: ["@ds"],
};

describe("deriveProjectState", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("a stale pinned packVersion sets upgradeAvailable", async () => {
    // Pin to a version below the installed CLI. The version-currency
    // helper is the single source of truth (`checkVersionCurrency` in
    // `version-currency.ts`); the deriver must consume it, not re-derive.
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: "v0.0.1" }),
    );
    const state = await deriveProjectState(dir);
    expect(state.upgradeAvailable).toBe(true);
  });

  it("a current pinned packVersion clears upgradeAvailable", async () => {
    // Pin to exactly the installed CLI version — `semverLt(pinned,
    // installed)` is false, so `upgradeAvailable` must be false. The
    // ADR-0011 addendum (#341) is explicit: "upgrade available" lies
    // when the consumer is current.
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: `v${pkg.version}` }),
    );
    const state = await deriveProjectState(dir);
    expect(state.upgradeAvailable).toBe(false);
  });

  it("a missing managed file sets scaffoldGap (and the planner emits sync)", async () => {
    // A consumer with no managed files at all is the "fresh adopt"
    // shape; scaffoldGap must fire so `sync` is in the plan. The
    // managed-file scan is shared with the front door
    // (`scanScaffoldPresence`); we trust that and assert at the
    // state boundary only.
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: `v${pkg.version}` }),
    );
    const state = await deriveProjectState(dir);
    expect(state.scaffoldGap).toBe(true);
    expect(planRemediation(state)).toContain("sync");
  });

  it("a regressed migration end-state sets repairNeeded", async () => {
    // The #300 shape: pinned at a version whose verification chain
    // includes idempotent migrations (e.g. `meta-kind-hard` flips
    // `meta_kind_strict: true`). With the flag flipped back, the
    // chain's dry-run emits Changes — repairNeeded must fire so the
    // planner emits `repair` (ADR-0011 addendum).
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({
        ...BASE_CFG,
        packVersion: "v1.0.0",
        meta_kind_strict: false,
      }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      `export function Button() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
    );
    const state = await deriveProjectState(dir);
    expect(state.repairNeeded).toBe(true);
  });

  it("returns false for reserved-but-unwired slots (migrate-layout, reconcile, reconform)", async () => {
    // ADR-0018 reserves these slots in CANONICAL_ORDER, but their
    // detection + dispatch lands in future sub-issues of PRD #340.
    // Returning `false` conservatively means heal never tries to
    // execute a step its dispatcher can't handle. A future sub-issue
    // adding detection here must add dispatch in `heal.ts` at the
    // same time — these assertions are the regression seam that
    // catches a half-finished change.
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, packVersion: `v${pkg.version}` }),
    );
    const state = await deriveProjectState(dir);
    expect(state.layoutMigrationNeeded).toBe(false);
    expect(state.reconcileNeeded).toBe(false);
    expect(state.reconformNeeded).toBe(false);
  });
});
