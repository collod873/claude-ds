/**
 * The bare-`claude-ds` front door (PRD #325 sub-issue #331; rewired in #345 /
 * ADR-0018 to drive the shared remediation planner).
 *
 * Two axes are pinned here:
 *   - **Non-TTY** keeps today's commander help — the agent/automation contract.
 *   - **TTY / interactive** renders the "where you are / what's wrong" dashboard,
 *     then drives the *same* `planRemediation` brain `heal` uses: one commitment
 *     gate (preview rendered from the real planned `Change[]`), then auto-advance
 *     to clean, pausing only for genuine Ambiguities.
 *
 * The retired `recommendedNext` recommender is gone — no test asserts a
 * `→ Next: <type this>` breadcrumb any more. Instead we pin the commitment-gate
 * preview, the one-brain invariant (front door and heal produce the same ordered
 * plan), and the headless `--answers` drive.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { frontDoorCmd } from "../../src/commands/front-door";
import { buildCommitmentGate } from "../../src/lib/gate-preview";
import { makeSyncPackFiles } from "../../src/lib/ops/sync-pack-files";
import { loadProject } from "../../src/lib/project";
import { deriveProjectState } from "../../src/lib/project-state";
import { planRemediation } from "../../src/lib/remediation-planner";
import { run } from "../../src/lib/runner";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

const CURRENT = `v${pkg.version}`;

describe("bare `claude-ds` non-TTY (agent / automation)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("prints the commander help and does not run the dashboard", async () => {
		// runCli stubs stdin.isTTY to false and never sets stdout.isTTY, so this
		// exercises the non-TTY branch — the agent/automation contract is exactly
		// today's help bytes, no dashboard and no prompts.
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				packVersion: "v0.8.0",
				pack: "next-react",
				mode: "warn",
				app_dir: "app",
				claude_md_target: ".claude/CLAUDE.md",
			}),
		);

		const r = await runCli([], { cwd: dir });
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/Usage:\s*claude-ds/);
		expect(r.stdout).not.toMatch(/Where you are:/);
	});
});

describe("frontDoorCmd (TTY dashboard + commitment gate)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("pre-adopt: renders the dashboard and routes to adopt (not a planner state)", async () => {
		const out = await captureFrontDoor({ cwd: dir });

		expect(out).toMatch(/Where you are: pre-adopt/);
		expect(out).toMatch(/Run `claude-ds adopt --pack next-react`/);
		// No commitment gate in pre-adopt — adopt hands the project INTO the loop.
		expect(out).not.toMatch(/\[Enter\] to run all/);
	});

	it("adopted + clean tree: nothing to remediate, routes to the build command", async () => {
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		// #382: adopt now lands at the verification chain's fixed point, so heal is
		// a no-op here. The call is retained as a belt-and-braces guard against a
		// future migration that adds another end-state adopt doesn't yet seed.
		const healed = await runCli(["heal"], { cwd: dir });
		expect(healed.code).toBe(0);
		// Add a user `build` script. package.json is a managed hybrid file (owned
		// keys: scripts, devDependencies), and #463 makes `scaffoldGap` content-
		// aware — so the script must be added WITHOUT drifting the owned keys, or
		// the gate would (correctly) plan sync. mergeScripts keeps non-pack scripts
		// ahead of the pack-owned ones, so writing `build` first in canonical
		// 2-space format keeps the file byte-identical to what sync would produce.
		const pkgPath = join(dir, "package.json");
		const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
		pkg.scripts = { build: "next build", ...pkg.scripts };
		await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

		const out = await captureFrontDoor({ cwd: dir });

		expect(out).toMatch(/Where you are: adopted/);
		expect(out).toMatch(/Nothing to remediate — the tree is clean/);
		expect(out).toMatch(/Run `npm run build`/);
		// #504: the read-only completeness scans that ran clean are named, so a
		// passing check is distinguishable from one that never ran.
		expect(out).toMatch(/Also checked: no hand-rolled DS infra, nothing stale or deprecated ✓/);
	});

	it("adopted + hand-rolled validator: surfaces it, never claims clean (#504)", async () => {
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		// The Crewops miss (#505): a hand-rolled base-ui asChild validator the
		// drift scan is blind to. #504's blocker required the owned-concern scan
		// to catch this class before any "clean ✓" line ships — so the front door
		// runs it, names the defect under "What's wrong", and keeps it OUT of
		// "Also checked".
		await mkdir(join(dir, "scripts"), { recursive: true });
		await writeFile(
			join(dir, "scripts/base-ui-aschild-validator.sh"),
			`#!/bin/bash
# base-ui-aschild-validator.sh — asChild is Radix-only; base-ui uses the render prop
if grep -q "asChild" "$1"; then
  echo "asChild not allowed on a base-ui scaffold"
  exit 1
fi
`,
		);

		const out = await captureFrontDoor({ cwd: dir });

		expect(out).toMatch(/Where you are: adopted/);
		expect(out).toMatch(/What's wrong:.*hand-rolled DS infra/);
		// The found scan is not named clean; the deprecated scan still is.
		expect(out).not.toMatch(/Also checked:.*no hand-rolled DS infra/);
		expect(out).toMatch(/Also checked: nothing stale or deprecated ✓/);
		// Never reported clean — routed to the command that resolves it.
		expect(out).not.toMatch(/Nothing to remediate — the tree is clean/);
		expect(out).toMatch(/claude-ds doctor --completeness/);
	});

	it("adopted + auto-fixable drift: the gate plans audit --fix", async () => {
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		// A correctly-placed atom with the retired meta.states field →
		// DRIFT-STALE-META-STATES, an auto-fixable finding.
		await writeFile(
			join(dir, "design-system/atoms/solo-label.tsx"),
			`export const meta = { kind: 'atom' as const, states: { loading: true } };
export function SoloLabel() { return <span />; }
`,
		);

		const out = await captureFrontDoor({ cwd: dir });

		expect(out).toMatch(/Where you are: adopted/);
		expect(out).toMatch(/I'll bring this tree to clean/);
		expect(out).toMatch(/audit --fix — auto-repair \d+ finding/);
	});

	it("adopted + auto-fixable drift: the audit --fix step previews the finding set per rule (#584)", async () => {
		// The bare "auto-repair N findings" count gives the operator nothing to
		// consent to. Under the step header the gate must group the consumed finding
		// set by rule id, naming severity, finding count, and affected-file count —
		// composed from the same scan the planner used, not a new prediction.
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		// Two atoms each carrying the retired meta.states field → two
		// DRIFT-STALE-META-STATES findings across two files, all auto-fixable.
		for (const name of ["solo-label", "duo-label"]) {
			await writeFile(
				join(dir, `design-system/atoms/${name}.tsx`),
				`export const meta = { kind: 'atom' as const, states: { loading: true } };
export function ${name === "solo-label" ? "SoloLabel" : "DuoLabel"}() { return <span />; }
`,
			);
		}

		const out = await captureFrontDoor({ cwd: dir });

		// The per-rule line sits under the audit --fix header, before the prompt:
		// rule id · severity · finding count · affected-file count.
		expect(out).toMatch(/audit --fix — auto-repair 2 findings/);
		expect(out).toMatch(/\[DRIFT-STALE-META-STATES\] error · 2 findings · 2 files/);
	});

	it("adopted + MISPLACED finding: the gate plans classify (#245)", async () => {
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		await mkdir(join(dir, "design-system/composites"), { recursive: true });
		for (const name of ["card", "button", "input"]) {
			await writeFile(
				join(dir, `design-system/atoms/${name}.tsx`),
				`export function ${name[0].toUpperCase()}${name.slice(1)}() { return <div />; }\n`,
			);
		}
		await writeFile(
			join(dir, "design-system/atoms/sidebar.tsx"),
			`import { Card } from "@/design-system/atoms/card";
import { Button } from "@/design-system/atoms/button";
import { Input } from "@/design-system/atoms/input";
export function Sidebar() { return <Card><Button /><Input /></Card>; }
`,
		);

		const out = await captureFrontDoor({ cwd: dir });

		expect(out).toMatch(/classify — extract \/ relocate/);
	});

	it("adopted + stale packVersion (clean tree): the gate plans upgrade first", async () => {
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		const cfgPath = join(dir, ".claude-ds.json");
		const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
		cfg.packVersion = "v0.0.1";
		await writeFile(cfgPath, JSON.stringify(cfg));

		const out = await captureFrontDoor({ cwd: dir });

		expect(out).toMatch(/What's wrong: .*upgrade available/);
		expect(out).toMatch(/upgrade — pack v0\.0\.1 → /);
	});

	it("adopted + content-drifted managed file: dashboard isn't clean, gate plans sync (#463)", async () => {
		// A managed file PRESENT on disk but byte-drifted. Presence-only health
		// reported "Managed files: N/N ✓" while `sync --dry-run` would rewrite it;
		// the dashboard must now reflect the drift (no clean tick) and the gate
		// must plan `sync`.
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		// Clean fixed point first, so the only thing wrong is the drift we inject.
		const healed = await runCli(["heal"], { cwd: dir });
		expect(healed.code).toBe(0);

		await writeFile(
			join(dir, ".claude/hooks/atom-imports.sh"),
			"#!/usr/bin/env bash\n# drifted — not canonical\n",
		);

		const out = await captureFrontDoor({ cwd: dir });

		// No "clean" claim: the managed-files line must not carry the ✓ tick.
		expect(out).not.toMatch(/Managed files: \d+\/\d+ ✓/);
		expect(out).toMatch(/scaffold incomplete/);
		// And the gate plans the restore.
		expect(out).toMatch(/sync — restore managed scaffold files/);
	});

	it("adopted + missing managed files: the gate previews the real sync Change[]", async () => {
		// Seed config pinned to the CURRENT version (so upgrade does not lead) with
		// no scaffold on disk — the canonical "managed files missing" case. The gate
		// must render the real planned restores. Default render (C4 #414) collapses
		// them to a tier summary; `--verbose` would dump one line per file.
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				packVersion: CURRENT,
				pack: "next-react",
				mode: "warn",
				app_dir: "app",
				claude_md_target: ".claude/CLAUDE.md",
			}),
		);

		const out = await captureFrontDoor({ cwd: dir });

		expect(out).toMatch(/sync — restore managed scaffold files/);
		// C4: tier-summary collapse. The count is the real planned Change[] count
		// (the F11 invariant); the previous "A path" per-file assertion now lives
		// on the F11 test below, which switches to `verbose: true`.
		expect(out).toMatch(/\bAdded \d+ scaffold files\b|\b\d+ files added\b/);
	});
});

describe("front door drives the shared planner (ADR-0018)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("one-brain invariant: the gate's plan IS planRemediation(deriveProjectState) — upgrade before audit", async () => {
		// A tree that is BOTH version-stale AND has auto-fixable drift. The retired
		// recommender ranked `upgrade` last (findings outranked it); the shared
		// planner ranks it first. This pins the structural guard against re-
		// divergence: the front door renders exactly the planner's ordered plan, and
		// that plan is what heal dispatches too (both call the same planner).
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		const cfgPath = join(dir, ".claude-ds.json");
		const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
		cfg.packVersion = "v0.0.1";
		await writeFile(cfgPath, JSON.stringify(cfg));
		await writeFile(
			join(dir, "design-system/atoms/solo-label.tsx"),
			`export const meta = { kind: 'atom' as const, states: { loading: true } };
export function SoloLabel() { return <span />; }
`,
		);

		// The single ordering brain, computed directly.
		const state = await deriveProjectState(dir);
		const plan = planRemediation(state);
		expect(plan).toContain("upgrade");
		expect(plan).toContain("audit --fix");
		expect(plan.indexOf("upgrade")).toBeLessThan(plan.indexOf("audit --fix"));

		// The front door renders that exact ordered plan — no second brain, no
		// re-ordering. The gate header lists the plan joined by ` → `.
		const out = await captureFrontDoor({ cwd: dir });
		expect(out).toContain(plan.join(" → "));
	});

	it("F11: the gate preview count equals the planned Change[] (no divergent recommender)", async () => {
		// Seed a scaffold-less adopted tree pinned to CURRENT so the only byte-
		// deterministic step is sync. The gate's sync block must list exactly as
		// many file-change lines as the sync Op's own dry-run plans — the preview
		// IS the real planned Change[], not an independently-computed count.
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				packVersion: CURRENT,
				pack: "next-react",
				mode: "warn",
				app_dir: "app",
				claude_md_target: ".claude/CLAUDE.md",
			}),
		);

		const ctx = await loadProject(dir);
		const dryRun = await run(ctx, [makeSyncPackFiles({})], "dry-run", { quiet: true });
		const plannedCount = dryRun.ops.reduce((n, o) => n + o.changes.length, 0);
		expect(plannedCount).toBeGreaterThan(0);

		// C4 (#414): the default tier-summary collapse hides per-file lines; pass
		// `verbose: true` so the F11 invariant — preview count == planned count —
		// still has a per-file surface to count.
		const gateLines = await buildCommitmentGate(
			ctx,
			["sync"],
			{ classifyCount: 0, autoFixableCount: 0 },
			{ verbose: true },
		);
		const changeLineCount = gateLines.filter((l) => /^\s+[AMRD] /.test(l)).length;

		expect(changeLineCount).toBe(plannedCount);
	});

	it("non-interactive without --yes is preview-only: changes nothing", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				packVersion: CURRENT,
				pack: "next-react",
				mode: "warn",
				app_dir: "app",
				claude_md_target: ".claude/CLAUDE.md",
			}),
		);
		const before = await readFile(join(dir, ".claude-ds.json"), "utf8");

		await captureFrontDoor({ cwd: dir });

		// The scaffold is still absent — the preview drove nothing.
		let scaffoldRestored = true;
		try {
			await readFile(join(dir, "design-system/tokens.json"), "utf8");
		} catch {
			scaffoldRestored = false;
		}
		expect(scaffoldRestored).toBe(false);
		expect(await readFile(join(dir, ".claude-ds.json"), "utf8")).toBe(before);
	});

	it("AC6: --answers drives the loop to a fixed point without a TTY", async () => {
		// Equidistant-token Ambiguity (the heal #333 fixture): `padding: 12` ties
		// between spacing-2 (8) and spacing-4 (16). With a pre-supplied --answers
		// file the front door resolves it silently and converges — the no-pseudo-TTY
		// automation path. Pairs `interactive: false` with `yes: true` (the headless
		// authorization) so no [Enter] is awaited.
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				packVersion: "v0.9.0",
				pack: "next-react",
				mode: "warn",
				domain_roots: ["features", "lib"],
				ds_aliases: ["@ds"],
			}),
		);
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(
			join(dir, "design-system/tokens.json"),
			JSON.stringify({ spacing: { 2: "8", 4: "16" } }),
		);
		await writeFile(
			join(dir, "design-system/atoms/card.tsx"),
			[
				`export function Card() { return <div style={{ padding: 12 }}>x</div>; }`,
				`export const meta = { kind: "atom" as const, examples: [] };`,
				``,
			].join("\n"),
		);

		const answersPath = join(dir, "answers.json");
		await writeFile(
			answersPath,
			JSON.stringify({
				"DRIFT-INLINE-STATIC-STYLE:design-system/atoms/card.tsx::token-tie:padding:12": 0,
			}),
		);

		const out = await captureFrontDoor({
			cwd: dir,
			interactive: false,
			yes: true,
			answers: answersPath,
			maxIterations: 5,
		});

		// Converged: the front door printed the clean verdict and the fixer ran
		// (padding: 12 → token), with no Ambiguity ever blocking the headless loop.
		expect(out).toMatch(/Tree is clean/);
		const card = await readFile(join(dir, "design-system/atoms/card.tsx"), "utf8");
		expect(card).not.toContain("padding: 12");
	}, 60000);

	it("inner loop steps emit no `→ Next` breadcrumb when the front door drives to clean", async () => {
		// Regression for the contradictory-output defect: a stale-pin clean tree
		// healed to "✓ Tree is clean" but the inner `upgrade` step still printed
		// "→ Next: run 'claude-ds audit'" — sending the operator to run a step the
		// loop already auto-ran (the C2/#414 defect, leaked through upgrade). Issue
		// #437 made each loop member return a `CommandResult` whose `→ Next`
		// breadcrumb is caller-owned; the driver discards it, so the front door owns
		// the single authoritative verdict. Pinning to v1.0.0 (the latest
		// registry version, with no migration chain to the current CLI) reproduces
		// the user's exact "no registered migrations → pin bump only" no-op path.
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		const cfgPath = join(dir, ".claude-ds.json");
		const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
		cfg.packVersion = "v1.0.0";
		await writeFile(cfgPath, JSON.stringify(cfg));

		const out = await captureFrontDoor({
			cwd: dir,
			interactive: false,
			yes: true,
			maxIterations: 5,
		});

		// Converged on the authoritative verdict, with zero inner-step breadcrumbs
		// contradicting it.
		expect(out).toMatch(/Tree is clean/);
		expect(out).not.toMatch(/→ Next/);
		expect(out).not.toContain("run 'claude-ds audit'");
	}, 60000);

	it("closing summary: footer names the version, what's new, and 'start working' (#503)", async () => {
		// The bare "✓ Tree is clean" gave the operator nothing about what the run
		// delivered. After convergence the footer states the version reached, what
		// landed since the pinned version (sourced from the migration chain), and a
		// "nothing needs your attention" go-ahead. Pin v1.0.0 so the chain to the
		// current CLI carries the v1.7.0 highlights.
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		const cfgPath = join(dir, ".claude-ds.json");
		const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
		cfg.packVersion = "v1.0.0";
		await writeFile(cfgPath, JSON.stringify(cfg));

		const out = await captureFrontDoor({
			cwd: dir,
			interactive: false,
			yes: true,
			maxIterations: 5,
		});

		expect(out).toMatch(new RegExp(`Tree is clean — ${CURRENT}`));
		expect(out).toMatch(/New since v1\.0\.0:/);
		expect(out).toMatch(/chart palette/);
		expect(out).toMatch(/Nothing needs your attention — start working/);
	}, 60000);

	it("closing summary: converged loop still downgrades 'start working' if hand-rolled infra remains (#504)", async () => {
		// The remediation loop fixes drift, but completeness (ADR-0003) is not a
		// loop member — a hand-rolled validator survives a clean convergence. The
		// footer must NOT issue the "start working" go-ahead while that infra
		// stands; it downgrades to the one command that resolves it.
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		// Auto-fixable drift so the plan is non-empty and the loop drives to clean.
		await writeFile(
			join(dir, "design-system/atoms/solo-label.tsx"),
			`export const meta = { kind: 'atom' as const, states: { loading: true } };
export function SoloLabel() { return <span />; }
`,
		);
		// A hand-rolled validator the drift scan is blind to — found by the
		// owned-concern scan, untouched by the loop.
		await mkdir(join(dir, "scripts"), { recursive: true });
		await writeFile(
			join(dir, "scripts/base-ui-aschild-validator.sh"),
			`#!/bin/bash
# base-ui-aschild-validator.sh — asChild is Radix-only; base-ui uses the render prop
if grep -q "asChild" "$1"; then exit 1; fi
`,
		);

		const out = await captureFrontDoor({
			cwd: dir,
			interactive: false,
			yes: true,
			maxIterations: 5,
		});

		// Loop converged...
		expect(out).toMatch(new RegExp(`Tree is clean — ${CURRENT}`));
		// ...but the go-ahead is withheld and routed to the resolving command.
		expect(out).not.toMatch(/Nothing needs your attention — start working/);
		expect(out).toMatch(/hand-rolled DS infra finding.*remain/);
		expect(out).toMatch(/claude-ds doctor --completeness/);
	}, 60000);
});

describe("front-door commitment-gate prompt contract (#584 / G3)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	/** Seed an adopted tree with one auto-fixable finding so the plan is
	 *  non-empty and the gate prompts. */
	async function seedFixableTree(): Promise<void> {
		const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
		expect(r.code).toBe(0);
		await writeFile(
			join(dir, "design-system/atoms/solo-label.tsx"),
			`export const meta = { kind: 'atom' as const, states: { loading: true } };
export function SoloLabel() { return <span />; }
`,
		);
	}

	it("any-other-input cancels: the exact prompt is shown and nothing changes", async () => {
		await seedFixableTree();
		const before = await readFile(join(dir, "design-system/atoms/solo-label.tsx"), "utf8");

		const out = await captureFrontDoorInteractive(dir, "nope\n");

		// The prompt string is pinned — the [Enter]-approves affordance is the
		// consent contract this gate exists to honor.
		expect(out).toContain("[Enter] to run all, anything else to cancel:");
		// Non-empty input cancels; the tree is untouched.
		expect(out).toMatch(/Cancelled — nothing changed\./);
		expect(out).not.toMatch(/Tree is clean/);
		expect(await readFile(join(dir, "design-system/atoms/solo-label.tsx"), "utf8")).toBe(before);
	});

	it("empty input ([Enter]) approves: the loop drives to clean", async () => {
		await seedFixableTree();

		const out = await captureFrontDoorInteractive(dir, "\n");

		// Empty input is approval — the gate does not cancel and the loop converges.
		expect(out).toContain("[Enter] to run all, anything else to cancel:");
		expect(out).not.toMatch(/Cancelled — nothing changed\./);
		expect(out).toMatch(/Tree is clean/);
		// The fixer ran: the retired meta.states field is gone.
		expect(await readFile(join(dir, "design-system/atoms/solo-label.tsx"), "utf8")).not.toContain(
			"states:",
		);
	}, 60000);
});

/**
 * Drive the front door through its interactive `[Enter]` gate, feeding `stdin`
 * to the readline prompt. Unlike `captureFrontDoor` (which forces
 * `interactive: false`), this exercises the real `awaitCommitment` path so the
 * prompt string and the empty-approves / other-cancels contract are pinned.
 */
async function captureFrontDoorInteractive(cwd: string, stdin: string): Promise<string> {
	const origStdoutWrite = process.stdout.write.bind(process.stdout);
	const origConsoleLog = console.log;
	const origConsoleInfo = console.info;
	const origStdinDesc = Object.getOwnPropertyDescriptor(process, "stdin");
	let stdout = "";
	const fmt = (args: unknown[]) =>
		`${args
			.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
			.join(" ")}\n`;
	process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
		stdout += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
		const cb = rest.find((r) => typeof r === "function") as ((err?: Error) => void) | undefined;
		if (cb) cb();
		return true;
	}) as typeof process.stdout.write;
	console.log = (...args: unknown[]) => {
		stdout += fmt(args);
	};
	console.info = (...args: unknown[]) => {
		stdout += fmt(args);
	};
	const fakeStdin = Readable.from(stdin) as Readable & { isTTY?: boolean };
	fakeStdin.isTTY = false;
	Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
	try {
		await frontDoorCmd({ cwd, interactive: true, maxIterations: 5 });
	} finally {
		process.stdout.write = origStdoutWrite as typeof process.stdout.write;
		console.log = origConsoleLog;
		console.info = origConsoleInfo;
		if (origStdinDesc) Object.defineProperty(process, "stdin", origStdinDesc);
	}
	return stdout;
}

/**
 * Drive the orchestrator directly, capturing stdout. Defaults to
 * `interactive: false` with no `yes`, so by default this renders the dashboard
 * + commitment-gate preview and stops — it changes nothing on disk. Pass
 * `yes: true` (and `answers`) to exercise the headless drive.
 */
async function captureFrontDoor(opts: {
	cwd: string;
	interactive?: boolean;
	yes?: boolean;
	answers?: string;
	maxIterations?: number;
}): Promise<string> {
	const origStdoutWrite = process.stdout.write.bind(process.stdout);
	const origConsoleLog = console.log;
	const origConsoleInfo = console.info;
	let stdout = "";
	const fmt = (args: unknown[]) =>
		`${args
			.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
			.join(" ")}\n`;
	process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
		stdout += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
		const cb = rest.find((r) => typeof r === "function") as ((err?: Error) => void) | undefined;
		if (cb) cb();
		return true;
	}) as typeof process.stdout.write;
	console.log = (...args: unknown[]) => {
		stdout += fmt(args);
	};
	console.info = (...args: unknown[]) => {
		stdout += fmt(args);
	};
	try {
		await frontDoorCmd({ interactive: false, ...opts });
	} finally {
		process.stdout.write = origStdoutWrite as typeof process.stdout.write;
		console.log = origConsoleLog;
		console.info = origConsoleInfo;
	}
	return stdout;
}
