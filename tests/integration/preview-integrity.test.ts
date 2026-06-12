/**
 * Preview-integrity tests (B1/B2 — issue #413 / PRD #407).
 *
 * The commitment gate must enumerate every step that will execute, including
 * `audit --fix` triggered by a config-flag cascade like `meta_kind_strict:
 * false → true`. The "what you approve" set must equal the "what runs" set.
 *
 * Fixture shape — pinned to v0.8.0 with `meta_kind_strict: false` and a
 * collection of DS atoms/composites that ALREADY have meta declarations but
 * *no* `kind:` field. Today's planner sees no DRIFT-META-KIND-MISSING (strict
 * flag is off) so it announces only `upgrade`; but the upgrade chain includes
 * meta-kind-hard@v0.9.0 which flips the flag, so the executed convergence is
 * `upgrade → audit --fix`. The preview must announce both.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCommitmentGate } from "../../src/lib/gate-preview";
import { loadProject } from "../../src/lib/project";
import { driveRemediation, type LoopStep } from "../../src/lib/remediation-driver";
import type { ProgressController } from "../../src/lib/render/tty-layer";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

const FILES_NEEDING_BACKFILL = [
	"design-system/atoms/alpha.tsx",
	"design-system/atoms/bravo.tsx",
	"design-system/atoms/charlie.tsx",
	"design-system/atoms/delta.tsx",
];

async function seedCascadeFixture(dir: string): Promise<void> {
	// Adopt at the current version, then rewrite the config back to v0.8.0 with
	// meta_kind_strict: false. The upgrade chain's meta-kind-hard@v0.9.0 will
	// then plan a flip → cascade. Seed DS files that already have a `meta`
	// declaration but no `kind:` so backfill targets them.
	const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
	expect(adopt.code).toBe(0);
	const cfgPath = join(dir, ".claude-ds.json");
	const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
	cfg.packVersion = "v0.8.0";
	cfg.meta_kind_strict = false;
	await writeFile(cfgPath, JSON.stringify(cfg));

	await mkdir(join(dir, "design-system/atoms"), { recursive: true });
	for (const rel of FILES_NEEDING_BACKFILL) {
		const base = rel.split("/").pop();
		if (!base) throw new Error(`unexpected empty path: ${rel}`);
		const Name = base.replace(/\.tsx$/, "");
		const Cap = Name[0].toUpperCase() + Name.slice(1);
		await writeFile(
			join(dir, rel),
			`export function ${Cap}() { return <span/>; }\nexport const meta = { examples: [] };\n`,
		);
	}
}

describe("B1/B2: preview integrity — announced plan equals executed plan", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("a meta_kind_strict cascade lands audit --fix in the announced plan", async () => {
		await seedCascadeFixture(dir);

		const ctx = await loadProject(dir);
		const gateLines = await buildCommitmentGate(ctx, ["upgrade"], {
			classifyCount: 0,
			autoFixableCount: 0,
		});
		const gate = gateLines.join("\n");

		// The plan header lists each step ordered by `→`. With the cascade
		// disclosed, `audit --fix` must appear in the announced plan even though
		// the current scan (strict=false) sees zero meta-kind-missing findings.
		expect(gate).toMatch(/upgrade.*→.*audit --fix/);
		// The plan-count line is rendered from `plan.length` — also bumps.
		expect(gate).toMatch(/2 steps:/);
	});

	it("a flag-flip cascade discloses the affected-file count in the preview", async () => {
		await seedCascadeFixture(dir);

		const ctx = await loadProject(dir);
		const gateLines = await buildCommitmentGate(ctx, ["upgrade"], {
			classifyCount: 0,
			autoFixableCount: 0,
		});
		const gate = gateLines.join("\n");

		// Blast radius: the flag flip's downstream impact named in counts, not
		// just a "config flipped" line. Four files lack meta.kind in the fixture.
		expect(gate).toMatch(/meta_kind_strict.*false.*true.*backfills meta\.kind.*4 files/i);
		// audit --fix header reflects the projected finding count, not zero.
		expect(gate).toMatch(/audit --fix — auto-repair 4 finding/);
	});

	it("announced step set equals executed step set on the cascade fixture", async () => {
		await seedCascadeFixture(dir);

		// The announced plan, as rendered.
		const ctx = await loadProject(dir);
		const announced = await buildCommitmentGate(ctx, ["upgrade"], {
			classifyCount: 0,
			autoFixableCount: 0,
		});
		const announcedSteps = extractAnnouncedSteps(announced);

		// The executed plan: drive the loop directly with a recording progress
		// controller. progress.start(step) fires once per dispatched step — that
		// is the canonical "step the loop ran" signal both drivers consume.
		const executed: LoopStep[] = [];
		const recordingProgress = makeRecordingProgress(executed);
		const outcome = await driveRemediation({
			cwd: dir,
			maxIterations: 5,
			progress: recordingProgress,
		});
		expect(outcome.kind).toBe("converged");
		const executedSteps = Array.from(new Set(executed));

		// Announced ⊇ executed: the gate must promise everything that runs. (We
		// permit announced to be a *superset* — if a projected cascade clears
		// mid-run, that is allowed; the asymmetric ban is "ran something we
		// didn't announce.")
		for (const step of executedSteps) {
			expect(announcedSteps).toContain(step);
		}
	}, 30000);
});

function extractAnnouncedSteps(lines: string[]): string[] {
	// The plan header line is the second non-blank line: `  upgrade → audit --fix`.
	// Split on the unicode arrow.
	const header = lines.find((l) => /→/.test(l) && !/^\s+[AMRD] /.test(l));
	if (!header) return [];
	return header
		.split("→")
		.map((s) => s.trim())
		.filter(Boolean);
}

function makeRecordingProgress(sink: LoopStep[]): ProgressController {
	return {
		start(text: string) {
			sink.push(text as LoopStep);
		},
		succeed() {},
		fail() {},
		info() {},
		stop() {},
		active: false,
		enabled: false,
	};
}
