/**
 * The shared remediation driver (#345 / ADR-0018). `heal` and the front door
 * are two consumers of `driveRemediation`; this suite pins the driver's
 * UI-neutral contract directly, independent of either caller's exit-code or
 * prose interpretation.
 *
 * The loop's *convergence* behavior (snapshot fixed-point, Pending early-exit,
 * ceiling) is exercised end-to-end through `heal.test.ts`; here we pin the
 * thinner guarantees the driver owns on its own: an immediately-clean tree
 * converges in one iteration with zero dispatch, and the iteration callback is
 * driven once per iteration so callers can flavor their own logging.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { dispatchStep, driveRemediation, snapshotTree } from "../../src/lib/remediation-driver";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

// A no-op progress controller (the non-TTY shape) so the driver runs without a
// spinner. Mirrors `NOOP_PROGRESS` without importing the TTY module.
const NOOP_PROGRESS = {
	start() {},
	succeed() {},
	fail() {},
	warn() {},
	info() {},
	stop() {},
	active: false,
	enabled: false,
} as const;

describe("driveRemediation (shared loop)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("a clean tree converges in one iteration and dispatches nothing", async () => {
		// #382: adopt lands at the verification chain's fixed point, so the
		// following heal is a no-op. The call is kept as a guard against a future
		// migration adding an end-state adopt doesn't yet seed.
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		const healed = await runCli(["heal"], { cwd: dir });
		expect(healed.code).toBe(0);

		const iterations: number[] = [];
		const outcome = await driveRemediation({
			cwd: dir,
			maxIterations: 3,
			progress: { ...NOOP_PROGRESS },
			onIteration: (i) => iterations.push(i),
		});

		// `ledger` rides on every outcome (#579) — match the verdict fields, not the
		// whole object, so the carried ledger instance doesn't break exact equality.
		expect(outcome).toMatchObject({ kind: "converged", iterations: 1 });
		// Empty plan on iteration 1 → the callback fired exactly once, no dispatch.
		expect(iterations).toEqual([1]);
	});

	it("never emits a bare `pass N/M` line — the labeled callback owns it (#591)", async () => {
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);
		const healed = await runCli(["heal"], { cwd: dir });
		expect(healed.code).toBe(0);

		const infoLines: string[] = [];
		await driveRemediation({
			cwd: dir,
			maxIterations: 3,
			progress: { ...NOOP_PROGRESS, info: (t: string) => infoLines.push(t) },
		});

		// The driver stays UI-neutral: no bare `pass N/M`. Labeling (with `(max)`) is
		// the caller's `onPassPlan` line.
		expect(infoLines.some((l) => /^pass \d+\/\d+$/.test(l))).toBe(false);
	});

	// #470: the retired `enforce` command is folded into the driver. At
	// convergence the brain promotes the hook mode WARN → BLOCK once the tree is
	// clean and the open-exception count is within `enforce_threshold` — the
	// WARN→BLOCK call a consumer used to hand-type `enforce` for.
	it("promotes warn→block at convergence when exceptions are within threshold (#470)", async () => {
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		// adopt lands in WARN (brownfield install) — the precondition the fold acts on.
		const cfgPath = join(dir, ".claude-ds.json");
		const before = JSON.parse(await readFile(cfgPath, "utf8"));
		expect(before.mode).toBe("warn");

		const outcome = await driveRemediation({
			cwd: dir,
			maxIterations: 3,
			progress: { ...NOOP_PROGRESS },
		});
		expect(outcome.kind).toBe("converged");

		const after = JSON.parse(await readFile(cfgPath, "utf8"));
		expect(after.mode).toBe("block");
	}, 30000);

	it("leaves warn untouched at convergence when open exceptions exceed threshold (#470)", async () => {
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		const cfgPath = join(dir, ".claude-ds.json");

		// Force threshold below the open-exception count: 1 open exception, threshold 0.
		const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
		cfg.enforce_threshold = 0;
		cfg.mode = "warn";
		await writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
		await writeFile(
			join(dir, "design-system/exceptions.json"),
			`${JSON.stringify(
				{
					exceptions: [
						{
							rule: "DRIFT-MISPLACED",
							path: "design-system/atoms/x.tsx",
							reason: "tracked",
							issue: "#1",
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		const outcome = await driveRemediation({
			cwd: dir,
			maxIterations: 3,
			progress: { ...NOOP_PROGRESS },
		});
		expect(outcome.kind).toBe("converged");

		const after = JSON.parse(await readFile(cfgPath, "utf8"));
		expect(after.mode).toBe("warn");
	}, 30000);

	it("empty plan + unresolvableFindings does NOT silently converge (#379)", async () => {
		// Adopt + heal to a fixed point, then introduce a ROLE-NO-CONTRACT finding
		// (an atom with `meta.role="tabs"` — no shipped contract). Its rule is
		// `fixable: false` AND `classifyRelocatable: false`, so `deriveProjectState`
		// sets only `unresolvableFindings` and `planRemediation` returns []. Before
		// this guard the driver's early-exit treated empty plan as `converged`,
		// re-introducing the exact silent-success regression #379 set out to
		// prevent. Surface it as non-convergence so heal exits loudly.
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);
		const healed = await runCli(["heal"], { cwd: dir });
		expect(healed.code).toBe(0);

		await writeFile(
			join(dir, "design-system/atoms/tabs.tsx"),
			`export function Tabs() { return <div/>; }
export const meta = { kind: "atom" as const, role: "tabs" as const, examples: [] };
`,
		);

		const outcome = await driveRemediation({
			cwd: dir,
			maxIterations: 2,
			progress: { ...NOOP_PROGRESS },
		});
		expect(outcome).toMatchObject({ kind: "exhausted", lastStep: null });
	}, 60000);

	it("regenerates a drifted generated showcase companion via reconform (#509)", async () => {
		// The #509 incident: a generated showcase goes stale and persists under
		// "tree is clean" because the planner could never schedule reconform. With
		// reconform wired (derivation + dispatch), driving to a fixed point must
		// regenerate the companion to its canonical @generated bytes.
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);
		const healed = await runCli(["heal"], { cwd: dir });
		expect(healed.code).toBe(0);

		await writeFile(
			join(dir, "design-system", "atoms", "tag.tsx"),
			`import type { Meta } from "@/design-system/types/meta";
export const meta: Meta = { kind: "atom", examples: [{ name: "default", props: {} }] };
export function Tag() { return null; }
`,
		);
		// Stale companion with the @generated header → GEN-002 drift the loop must repair.
		const stale = `// @generated by claude-ds — do not edit. Source: tag.tsx meta block.\nexport default function StaleStub() { return null; }\n`;
		const companionPath = join(dir, "design-system", "atoms", "tag.showcase.tsx");
		await writeFile(companionPath, stale);

		const outcome = await driveRemediation({
			cwd: dir,
			maxIterations: 5,
			progress: { ...NOOP_PROGRESS },
		});
		expect(outcome.kind).toBe("converged");

		const after = await readFile(companionPath, "utf8");
		expect(after).not.toBe(stale);
		expect(after.startsWith("// @generated by claude-ds")).toBe(true);
		expect(after).not.toContain("StaleStub");
	}, 60000);

	it("carries a run ledger on the outcome that records what the loop wrote (#579)", async () => {
		// The outcome must hand heal an inventory of what the run wrote, accumulated
		// from each step's RunReport — not a tree heal has to re-scan. Drive a drifted
		// generated companion to convergence (reconform writes it) and assert the
		// regenerated companion shows up in the ledger the outcome carries.
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);
		const healed = await runCli(["heal"], { cwd: dir });
		expect(healed.code).toBe(0);

		await writeFile(
			join(dir, "design-system", "atoms", "tag.tsx"),
			`import type { Meta } from "@/design-system/types/meta";
export const meta: Meta = { kind: "atom", examples: [{ name: "default", props: {} }] };
export function Tag() { return null; }
`,
		);
		await writeFile(
			join(dir, "design-system", "atoms", "tag.showcase.tsx"),
			`// @generated by claude-ds — do not edit. Source: tag.tsx meta block.\nexport default function StaleStub() { return null; }\n`,
		);

		const outcome = await driveRemediation({
			cwd: dir,
			maxIterations: 5,
			progress: { ...NOOP_PROGRESS },
		});
		expect(outcome.kind).toBe("converged");

		// The ledger is present and names the reconform-rewritten companion.
		const companion = join("design-system", "atoms", "tag.showcase.tsx");
		const reconformEntries = outcome.ledger.entries().filter((e) => e.step === "reconform");
		expect(reconformEntries).toContainEqual({
			step: "reconform",
			verb: "write",
			path: companion,
		});
		expect(outcome.ledger.render()).toContain(`reconform:`);
		expect(outcome.ledger.render()).toContain(companion);
	}, 60000);

	it("a byte-stable pass with a complaint still present exits naming the blocker, never repeats it (#532 defect 2)", async () => {
		// Defect 2's shape: a step is scheduled to clear a complaint, runs, changes
		// zero bytes, and the complaint persists — so the next pass would be
		// byte-for-byte identical. The original Crewops instance was the empty-
		// migration-range `upgrade` no-op, but #540 made upgrade advance the pin on
		// an empty range, so that complaint now legitimately resolves. The contract
		// is unchanged; the fixture moves to a complaint whose owning step genuinely
		// cannot make progress headlessly: a DS file misplaced in the wrong tier.
		// `DRIFT-MISPLACED` is classify-relocatable, so the planner schedules
		// `classify` — but classify can only relocate it interactively (it reports
		// "no files moved" and emits no Pending decision under heal), so the pass
		// no-ops while the MISPLACED complaint persists. Before #532 the driver read
		// a stable pass with findings as a loop-to-the-ceiling; now it re-derives,
		// sees the next plan would be identical, and exits at once naming `classify`.
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);
		const healed = await runCli(["heal"], { cwd: dir });
		expect(healed.code).toBe(0);

		// An atom (no design-system tier imports) parked in composites/ — the
		// classifier flags `DRIFT-MISPLACED`, the sole outstanding complaint. Its
		// owning step is `classify`, which no-ops headlessly.
		await writeFile(
			join(dir, "design-system", "composites", "lonelybtn.tsx"),
			`export function Lonelybtn() { return <button />; }
export const meta = { kind: "atom" as const, examples: [] };
`,
		);

		const outcome = await driveRemediation({
			cwd: dir,
			maxIterations: 3,
			progress: { ...NOOP_PROGRESS },
		});

		// Not converged (the complaint is unresolved), not spun to the ceiling
		// running the identical pass three times — exited at once naming `classify`.
		expect(outcome).toMatchObject({ kind: "exhausted", lastStep: "classify" });
		// The misplaced file was never silently relocated as a side effect.
		const stillThere = await readFile(
			join(dir, "design-system", "composites", "lonelybtn.tsx"),
			"utf8",
		);
		expect(stillThere).toContain("Lonelybtn");
	}, 60000);

	it("reconform that skipped every file it visited reports no progress, not ✔ (#532 defect 6)", async () => {
		// The Crewops defect 6: reconform printed ✔ after skipping every companion
		// it visited. A skip is not a fix — the showcase could be broken and the
		// check simply can't tell. The step must report "nothing to do," which the
		// loop keys off `StepResult.progress === false` to render instead of a ✔.
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);
		const healed = await runCli(["heal"], { cwd: dir });
		expect(healed.code).toBe(0);

		// A namespace-only export (#69) → not callable → no mechanically-regenerable
		// showcase → skip, plus an existing companion so the integrity op visits
		// (then skips) it. (JSX-bearing examples are now regenerated, not skipped.)
		await writeFile(
			join(dir, "design-system", "atoms", "widget.tsx"),
			`import React from "react";
function WidgetLine(props: any) { return <span {...props} />; }
export const Widget = { Line: WidgetLine };
export const meta = { kind: "atom" as const, examples: [{ name: "default", props: {} }], skip: [] };
`,
		);
		await writeFile(
			join(dir, "design-system", "atoms", "widget.showcase.tsx"),
			`// @generated by claude-ds — do not edit. Source: widget.tsx meta block.\nexport default function WidgetShowcase() { return null; }\n`,
		);

		const infoLines: string[] = [];
		const result = await dispatchStep("reconform", {
			cwd: dir,
			answers: undefined,
			pendingSink: undefined,
			progress: { ...NOOP_PROGRESS, info: (t: string) => infoLines.push(t) },
		});

		// Every visited companion was skipped — no bytes changed → no progress.
		expect(result.progress).toBe(false);
		// The skipped file is named for hand review, not hidden behind a checkmark.
		const skipLine = infoLines.find(
			(l) => l.includes("widget.showcase.tsx") && l.includes("skipped"),
		);
		expect(skipLine).toBeDefined();
		// #592: the ADR citation is reachable — a resolvable GitHub URL, not a bare
		// "ADR-0026" the pack ships no copy of.
		expect(skipLine).toMatch(
			/https:\/\/github\.com\/collod873\/claude-ds\/blob\/main\/docs\/adr\//,
		);
		expect(skipLine).not.toMatch(/\(ADR-\d{4}\)/);
	}, 60000);

	it("reconform that regenerated one companion but skipped another reports the skip count (#588)", async () => {
		// Progress + skips is the warn case: the step advanced (a drifted companion
		// got regenerated) yet a skipped file may hide an unverified end-state. The
		// step reports `progress: true` AND `skipped > 0` so the loop can route it to
		// ⚠ instead of a ✔ that would read as "all clear".
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);
		const healed = await runCli(["heal"], { cwd: dir });
		expect(healed.code).toBe(0);

		// Regenerable atom with a drifted companion → reconform rewrites it (progress).
		await writeFile(
			join(dir, "design-system", "atoms", "tag.tsx"),
			`import type { Meta } from "@/design-system/types/meta";
export const meta: Meta = { kind: "atom", examples: [{ name: "default", props: {} }] };
export function Tag() { return null; }
`,
		);
		await writeFile(
			join(dir, "design-system", "atoms", "tag.showcase.tsx"),
			`// @generated by claude-ds — do not edit. Source: tag.tsx meta block.\nexport default function StaleStub() { return null; }\n`,
		);
		// Namespace-only export (#69) → not mechanically regenerable → skipped.
		await writeFile(
			join(dir, "design-system", "atoms", "widget.tsx"),
			`import React from "react";
function WidgetLine(props: any) { return <span {...props} />; }
export const Widget = { Line: WidgetLine };
export const meta = { kind: "atom" as const, examples: [{ name: "default", props: {} }], skip: [] };
`,
		);
		await writeFile(
			join(dir, "design-system", "atoms", "widget.showcase.tsx"),
			`// @generated by claude-ds — do not edit. Source: widget.tsx meta block.\nexport default function WidgetShowcase() { return null; }\n`,
		);

		const result = await dispatchStep("reconform", {
			cwd: dir,
			answers: undefined,
			pendingSink: undefined,
			progress: { ...NOOP_PROGRESS },
		});

		// Regenerated tag → progress; widget skip surfaces in the count.
		expect(result.progress).toBe(true);
		expect(result.skipped).toBe(1);
	}, 60000);

	it("reconform that regenerated a companion with nothing skipped reports skipped 0 → ✔ (#588)", async () => {
		// The no-skip completion case acceptance criterion 2 pins: a step that made
		// progress with zero skips must report `skipped: 0` so the loop renders ✔, not
		// ⚠. Guards against a regression that always reports skips and warns on a clean
		// run. Same drifted-but-regenerable atom as above, minus the unregenerable one.
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);
		const healed = await runCli(["heal"], { cwd: dir });
		expect(healed.code).toBe(0);

		await writeFile(
			join(dir, "design-system", "atoms", "tag.tsx"),
			`import type { Meta } from "@/design-system/types/meta";
export const meta: Meta = { kind: "atom", examples: [{ name: "default", props: {} }] };
export function Tag() { return null; }
`,
		);
		await writeFile(
			join(dir, "design-system", "atoms", "tag.showcase.tsx"),
			`// @generated by claude-ds — do not edit. Source: tag.tsx meta block.\nexport default function StaleStub() { return null; }\n`,
		);

		const result = await dispatchStep("reconform", {
			cwd: dir,
			answers: undefined,
			pendingSink: undefined,
			progress: { ...NOOP_PROGRESS },
		});

		// Regenerated tag, nothing skipped → progress with a zero count → succeed path.
		expect(result.progress).toBe(true);
		expect(result.skipped).toBe(0);
	}, 60000);

	it("routes a progress+skips step to the warn glyph with the skip count (#588)", async () => {
		// Driver routing: progress + skips → progress.warn (⚠) carrying the skip
		// count, not progress.succeed (✔). Succeed stays reserved for no-skip
		// completion. Same tree as the dispatch test, driven through the full loop.
		const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(adopt.code).toBe(0);
		const healed = await runCli(["heal"], { cwd: dir });
		expect(healed.code).toBe(0);

		await writeFile(
			join(dir, "design-system", "atoms", "tag.tsx"),
			`import type { Meta } from "@/design-system/types/meta";
export const meta: Meta = { kind: "atom", examples: [{ name: "default", props: {} }] };
export function Tag() { return null; }
`,
		);
		await writeFile(
			join(dir, "design-system", "atoms", "tag.showcase.tsx"),
			`// @generated by claude-ds — do not edit. Source: tag.tsx meta block.\nexport default function StaleStub() { return null; }\n`,
		);
		await writeFile(
			join(dir, "design-system", "atoms", "widget.tsx"),
			`import React from "react";
function WidgetLine(props: any) { return <span {...props} />; }
export const Widget = { Line: WidgetLine };
export const meta = { kind: "atom" as const, examples: [{ name: "default", props: {} }], skip: [] };
`,
		);
		await writeFile(
			join(dir, "design-system", "atoms", "widget.showcase.tsx"),
			`// @generated by claude-ds — do not edit. Source: widget.tsx meta block.\nexport default function WidgetShowcase() { return null; }\n`,
		);

		const succeeded: string[] = [];
		const warned: Array<{ text?: string; reason?: string }> = [];
		await driveRemediation({
			cwd: dir,
			maxIterations: 5,
			progress: {
				...NOOP_PROGRESS,
				succeed: (t?: string) => succeeded.push(t ?? ""),
				warn: (t?: string, reason?: string) => warned.push({ text: t, reason }),
			},
		});

		// reconform made progress (regenerated tag) AND skipped widget → warn, not succeed.
		const reconformWarn = warned.find((w) => w.text === "reconform");
		expect(reconformWarn).toBeDefined();
		expect(reconformWarn?.reason).toMatch(/1 skipped/);
		expect(succeeded).not.toContain("reconform");
	}, 60000);

	it("forwards the iteration ceiling to the onIteration callback", async () => {
		// A scaffold-less tree pinned to the current version always has work
		// (sync), so the loop runs at least one iteration before it can converge —
		// enough to prove the callback is driven and the ceiling is forwarded.
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				packVersion: `v${pkg.version}`,
				pack: "next-react",
				mode: "warn",
				app_dir: "app",
				claude_md_target: ".claude/CLAUDE.md",
			}),
		);

		const iterations: number[] = [];
		const outcome = await driveRemediation({
			cwd: dir,
			maxIterations: 2,
			progress: { ...NOOP_PROGRESS },
			onIteration: (i, max) => {
				expect(max).toBe(2);
				iterations.push(i);
			},
		});

		// Either it converged (≤2 iters) or it exhausted — either way the callback
		// fired at least once and never past the ceiling.
		expect(iterations.length).toBeGreaterThanOrEqual(1);
		expect(Math.max(...iterations)).toBeLessThanOrEqual(2);
		expect(["converged", "exhausted"]).toContain(outcome.kind);
	}, 30000);
});

describe("snapshotTree (convergence detector)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	async function seed(rel: string, content: string): Promise<void> {
		const abs = join(dir, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}

	it("snapshots DS-managed files but skips build/generated dirs (#384, #385)", async () => {
		// A DS-managed file the loop mutates — MUST be watched for convergence.
		await seed("design-system/atoms/button.tsx", "export const Button = () => null;\n");
		// Build/generated output the loop never touches — MUST be skipped (OOM on
		// real trees walks the gigabyte .next cache twice per iteration). The
		// Vite/Nuxt/Parcel caches are the #385 retrigger: pre-consolidation
		// SNAPSHOT_SKIP only knew about .next.
		await seed(".next/cache/huge.txt", "build cache");
		await seed(".next/static/chunk.js", "chunk");
		await seed(".nuxt/dist/server.mjs", "nuxt build");
		await seed(".vite/deps/_metadata.json", "vite cache");
		await seed(".parcel-cache/blob", "parcel cache");
		await seed("dist/bundle.js", "bundle");
		await seed("coverage/lcov.info", "coverage");

		const snap = await snapshotTree(dir);

		expect(snap.has(join("design-system", "atoms", "button.tsx"))).toBe(true);

		const skipped = [".next", ".nuxt", ".vite", ".parcel-cache", "dist", "coverage"];
		for (const key of snap.keys()) {
			const segments = key.split(/[/\\]/);
			for (const dirName of skipped) {
				expect(segments).not.toContain(dirName);
			}
		}
	});
});
