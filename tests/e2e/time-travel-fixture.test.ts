import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_REGISTRY } from "../../src/lib/migration-registry.js";
import { scanOwnedConcerns } from "../../src/lib/owned-concerns/index.js";
import { semverLt } from "../../src/lib/version-currency.js";
import { cliVersion } from "../../src/lib/version-vocab.js";
import { materializeFixture, runInFixture } from "../helpers/e2e-fixture.js";
import { cleanup } from "../helpers/tmpdir.js";

/**
 * Time-travel fixture (PRD #529 / sub-issue #530).
 *
 * Pins the committed `crewops-shaped` consumer (adopted at the *previous*
 * published pack version) and the materialize/run helpers it ships with. These
 * assert the fixture reproduces the cross-version Crewops conditions offline and
 * that the helper interface returns transcript + exit code + tree — the seam the
 * journey and golden tests (later sub-issues) build on.
 */

const REPO_TSC = fileURLToPath(new URL("../../node_modules/.bin/tsc", import.meta.url));

/** Highest pack version that has a registered migration set. */
function latestRegisteredPackVersion(): string {
	return MIGRATION_REGISTRY.map((m) => m.version).reduce((hi, v) => (semverLt(hi, v) ? v : hi));
}

describe("time-travel fixture: crewops-shaped (#530)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await materializeFixture("crewops-shaped");
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("materializes a git repo whose working tree is clean (clean-tree guard sees real conditions)", () => {
		const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
		expect(status.status).toBe(0);
		expect(status.stdout.trim()).toBe("");
	});

	it("is pinned at the previous published release — behind the CLI, no migration range left", async () => {
		const { tree } = await runInFixture(dir, ["version"]);
		const cfg = JSON.parse(tree[".claude-ds.json"]) as { packVersion: string };
		// "Adopted at the previous published release, healed by this one": the pin
		// sits at-or-after the latest registered pack version (so the upgrade's
		// migration range is empty), yet the installed CLI is ahead — the
		// empty-migration-range upgrade scenario the journey must exercise.
		// At-or-after, not equality: the release-checklist refresh advances the
		// pin to one-behind-latest every release; migrations register more rarely.
		expect(semverLt(cfg.packVersion, latestRegisteredPackVersion())).toBe(false);
		expect(semverLt(cfg.packVersion, cliVersion())).toBe(true);
	});

	it("ships at least one hand-rolled DS infra file the Owned-concern scan flags", async () => {
		const findings = await scanOwnedConcerns({
			cwd: dir,
			manifestPaths: new Set<string>(),
			generatedPatterns: [],
		});
		const tokenLint = findings.find((f) => f.concernId === "OWNED-TOKEN-LINT");
		expect(tokenLint).toBeDefined();
		expect(tokenLint?.file).toBe("scripts/lint-tokens.ts");
	});

	it("contains stale JSX showcases that fail typecheck against the current components", () => {
		const tsc = spawnSync(REPO_TSC, ["-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" });
		// Non-zero: the consumer's `verify` (tsc --noEmit) fails — the verify-gate
		// defect reproduces. Both failures are stale showcases (JSX-bearing,
		// non-regenerable per ADR-0026), nothing else.
		expect(tsc.status).not.toBe(0);
		const out = tsc.stdout + tsc.stderr;
		expect(out).toMatch(/Button\.showcase\.tsx.*error TS/);
		expect(out).toMatch(/SearchBox\.showcase\.tsx.*error TS/);
		const errorFiles = new Set(
			out
				.split("\n")
				.filter((l) => l.includes("error TS"))
				.map((l) => l.split("(")[0]),
		);
		expect([...errorFiles].sort()).toEqual([
			"design-system/atoms/Button.showcase.tsx",
			"design-system/composites/SearchBox.showcase.tsx",
		]);
	});

	it("runs a command offline and returns transcript + exit code + tree", async () => {
		const run = await runInFixture(dir, ["version"]);
		expect(run.code).toBe(0);
		// Transcript surfaces both version axes — the cross-version relationship.
		// The pinned version comes from the fixture's own config, not a literal:
		// the release-checklist refresh advances it every release.
		const cfg = JSON.parse(run.tree[".claude-ds.json"]) as { packVersion: string };
		expect(run.transcript).toContain(`pinned: ${cfg.packVersion}`);
		expect(semverLt(cfg.packVersion, cliVersion())).toBe(true);
		expect(run.transcript).toContain(`installed: ${cliVersion()}`);
		// Tree is returned and a read-only command left the consumer files intact.
		expect(run.tree["design-system/atoms/Button.tsx"]).toContain("export function Button");
		expect(Object.keys(run.tree)).toContain("scripts/lint-tokens.ts");
	});
});
