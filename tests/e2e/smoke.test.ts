/**
 * Smoke e2e — run the **real built CLI** against the Crewops-shaped fixture
 * and emit the discovery catalogue.
 *
 * Discovery-first (PRD #407): the catalogue enumerates every current
 * deviation in a single pass instead of dripping them out release-by-release.
 * The test does NOT fail on harness deviations — those are surfaced via the
 * structured report (`e2e-report.json` at repo root, uploaded as a CI
 * artifact). The test only fails on environmental problems (missing CLI,
 * missing fixture, missing tsc).
 *
 * Auto-skips when `dist/cli.js` is absent so the suite stays green for devs
 * who haven't run `npm run build`. CI's e2e-smoke job builds first, so the
 * skip only triggers locally.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { freshTmpDir, cleanup } from "../helpers/tmpdir.js";
import { runE2eHarness, writeReport } from "./harness.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const DIST_CLI = resolve(REPO_ROOT, "dist", "cli.js");
const FIXTURE = resolve(REPO_ROOT, "tests", "e2e", "fixtures", "crewops-shaped");
const REPORT_PATH = resolve(REPO_ROOT, "e2e-report.json");

const hasDist = existsSync(DIST_CLI);

describe.skipIf(!hasDist)("e2e smoke: Crewops-shaped fixture", () => {
  it("adopt → heal → tsc produces a structured report", async () => {
    const workDir = await freshTmpDir("e2e-smoke-");
    try {
      const report = await runE2eHarness({
        fixtureDir: FIXTURE,
        cliPath: DIST_CLI,
        workDir,
        // 90s — heal can chain several inner commands plus a tsc pass.
        timeoutMs: 90_000,
      });

      await writeReport(report, REPORT_PATH);

      // The report itself is what we publish. Non-blocking: an unfixed
      // deviation is data for the catalogue, not a failed test. We only
      // assert structural invariants of the report itself so a regression
      // in the harness shows up here.
      expect(report.fixture).toBe("crewops-shaped");
      expect(report.steps.length).toBeGreaterThan(0);
      expect(report.steps[0].name).toBe("adopt");
      expect(typeof report.pass).toBe("boolean");

      // A1 (PRD #407 / issue #409): the meta-kind-missing fixer must merge
      // `kind` into the existing `export const meta` instead of appending a
      // second one. Locked in as a blocking assertion now that
      // `mergeMetaKind` is wired up — a regression that resurrects the
      // append-only behaviour fails the smoke gate, not just the unit table.
      const duplicateMeta = report.deviations.filter((d) => d.category === "duplicate-meta-decl");
      expect(duplicateMeta, JSON.stringify(duplicateMeta, null, 2)).toHaveLength(0);

      // Human-readable summary line so the run page shows the bottom line
      // without the operator having to download the artifact.
      // eslint-disable-next-line no-console
      console.log(
        `[e2e-smoke] pass=${report.pass} deviations=${report.deviations.length} ` +
          `steps=${report.steps.map((s) => `${s.name}(${s.exitCode})`).join(",")}`,
      );
    } finally {
      await cleanup(workDir);
    }
  }, 120_000);
});
