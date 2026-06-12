/**
 * Plan/report reconciliation invariant (PRD #529 defect-3 class, issue #536).
 *
 * The commitment-gate preview's declared `Change[]` per step must equal what the
 * step's apply path writes — counts, files, and version claims. A divergence is
 * the defect-3 class: a preview that promises one thing while apply does another.
 * The concrete Crewops instance was a `pin bump only — pack stays v1.7.0` header
 * over a `(no file changes — version pin only)` body, while the real `upgrade`
 * advanced the pin (a `.claude-ds.json` write) — the [Enter] confirmation was
 * misinformed consent.
 *
 * The comparison is a pure data diff over a frozen ctx: the preview is dry-run,
 * the apply path is dry-run, no bytes touch disk. Milliseconds after the
 * one-time adopt setup.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { buildCommitmentGate, previewStepChanges } from "../../src/lib/gate-preview";
import { computeMigrationChain } from "../../src/lib/migration-framework";
import { MIGRATION_REGISTRY } from "../../src/lib/migration-registry";
import { finalizeUpgrade } from "../../src/lib/ops/finalize-upgrade";
import { loadProject } from "../../src/lib/project";
import { run } from "../../src/lib/runner";
import { semverLt } from "../../src/lib/version-currency";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

const CLI_VERSION = `v${pkg.version}`;

/**
 * The highest registered migration `<=` the CLI: the last migration the CLI
 * applies, so the chain from it up to the CLI is empty *by construction*
 * regardless of which migrations exist (the #499-proof derivation copied from
 * `version-vocab-surfaces.test.ts`). When the CLI is ahead of it, this pin is a
 * genuinely stale-but-empty-chain pin — the exact Crewops v1.7.0 → v1.8.x shape.
 */
const EMPTY_CHAIN_PIN = (() => {
	const atOrBelowCli = MIGRATION_REGISTRY.map((m) => m.version).filter(
		(v) => !semverLt(CLI_VERSION, v),
	);
	return atOrBelowCli.reduce((hi, v) => (semverLt(hi, v) ? v : hi), atOrBelowCli[0] ?? CLI_VERSION);
})();

/** Only meaningful when the derived pin is genuinely below the CLI (a stale
 *  empty chain). False only on the release that ships a migration at its own
 *  version, where pin === CLI and there is no pin to advance. */
const HAS_STALE_EMPTY_CHAIN = semverLt(EMPTY_CHAIN_PIN, CLI_VERSION);

async function seedEmptyChainFixture(dir: string): Promise<void> {
	const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
	expect(adopt.code).toBe(0);
	const cfgPath = join(dir, ".claude-ds.json");
	const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
	cfg.packVersion = EMPTY_CHAIN_PIN;
	await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
}

describe.runIf(HAS_STALE_EMPTY_CHAIN)(
	"plan/report reconciliation — empty-chain upgrade (issue #536)",
	() => {
		let dir: string;
		beforeEach(async () => {
			dir = await freshTmpDir();
		});
		afterEach(async () => {
			await cleanup(dir);
		});

		it("fixture sanity: the seeded pin yields a genuinely empty migration chain", () => {
			expect(computeMigrationChain(EMPTY_CHAIN_PIN, CLI_VERSION, MIGRATION_REGISTRY)).toEqual([]);
		});

		it("preview's declared upgrade Change[] reconciles with the apply path (counts + files + version)", async () => {
			await seedEmptyChainFixture(dir);
			const ctx = await loadProject(dir);

			// Planner's declared changes for the upgrade step (preview side).
			const declared = await previewStepChanges(ctx, "upgrade");
			if (declared === null) throw new Error("upgrade is a byte-deterministic step — never null");

			// The apply side: `upgrade` runs `finalizeUpgrade` on an empty chain
			// (upgrade.ts) to advance the pin. Dry-run over the same frozen ctx so no
			// bytes move — this is the RunReport the [Enter] approval commits to.
			const report = await run(
				ctx,
				[finalizeUpgrade(CLI_VERSION, ctx.cfg.allowed_imports)],
				"dry-run",
				{ quiet: true },
			);
			const applied = report.ops.flatMap((o) => o.changes);

			// Counts reconcile: the pin advance is exactly one write, not zero.
			expect(declared.length).toBe(applied.length);
			expect(declared.length).toBeGreaterThan(0);

			// Files reconcile: same paths, both naming `.claude-ds.json`.
			const declaredPaths = declared.map((e) => e.change.path).sort();
			const appliedPaths = applied.map((c) => c.path).sort();
			expect(declaredPaths).toEqual(appliedPaths);
			expect(declaredPaths).toContain(".claude-ds.json");

			// Version claim reconciles: the declared write moves packVersion from the
			// stale pin to the CLI — the same transition apply performs.
			const cfgWrite = declared.find((e) => e.change.path === ".claude-ds.json")?.change;
			expect(cfgWrite?.kind).toBe("write");
			if (cfgWrite?.kind === "write" && cfgWrite.before) {
				const before = JSON.parse(cfgWrite.before.toString("utf8"));
				const after = JSON.parse(cfgWrite.after.toString("utf8"));
				expect(before.packVersion).toBe(EMPTY_CHAIN_PIN);
				expect(after.packVersion).toBe(CLI_VERSION);
			}
		});

		it("defect 3: the rendered gate is not self-contradictory (header pin advance == body pin write)", async () => {
			await seedEmptyChainFixture(dir);
			const ctx = await loadProject(dir);

			const gate = (
				await buildCommitmentGate(ctx, ["upgrade"], { classifyCount: 0, autoFixableCount: 0 })
			).join("\n");

			// Header names the real pin advance — never the retired contradiction
			// ("pack stays vX") nor a phantom migration arrow.
			expect(gate).toContain(`pin advance ${EMPTY_CHAIN_PIN} → ${CLI_VERSION} (no migrations)`);
			expect(gate).not.toMatch(/pack stays/);
			expect(gate).not.toMatch(/no file changes/);

			// Body shows the matching `.claude-ds.json` pin write — surfaced (per
			// #591) as `pack pinned <from> → <to>`, not a generic flag flip — so
			// header and body agree.
			expect(gate).toContain(`pack pinned ${EMPTY_CHAIN_PIN} → ${CLI_VERSION}`);
		});
	},
);
