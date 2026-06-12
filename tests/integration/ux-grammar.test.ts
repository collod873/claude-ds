/**
 * Issue #414 / C2-C3-C4 — UX grammar end-to-end.
 *
 * Pin the three acceptance criteria against the **non-TTY byte stream** (the
 * agent surface — TTY adds color but is byte-identical to this stream by
 * `tty-layer`'s identity adapter). The PRD calls these out explicitly:
 *
 *   - C2: "→ Next: run X" appears only for genuinely external actions; no
 *     step the tool auto-runs is printed as a manual next step.
 *   - C3: Convergence output includes a one-line explanation and meaningful
 *     pass labels (so "pass 1/3" never reads as a stuck loop).
 *   - C4: Per-file change lists collapse to a tier summary by default;
 *     `--verbose` shows the full list.
 *
 * The shared invariant across all three: assertions run against `r.stdout` /
 * `r.stderr`, never against rendered TTY.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../helpers/runcli";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

const BASE_CFG = {
	packVersion: "v0.9.0",
	pack: "next-react",
	mode: "warn",
	domain_roots: ["features", "lib"],
	ds_aliases: ["@ds"],
};

// The full set of LoopSteps `heal`/the front door run themselves (ADR-0018).
// C2: no `→ Next: run X` line may name one of these. `audit` (read-only) is
// not in this set — it's a diagnostic, never a loop member.
const LOOP_STEPS = [
	"audit --fix",
	"claude-ds upgrade",
	"claude-ds sync",
	"claude-ds repair",
	"claude-ds migrate-layout",
	"claude-ds reconcile",
	"claude-ds classify",
	"claude-ds reconform",
];

function nextStepLine(stream: string): string | undefined {
	return stream.split("\n").find((l) => l.includes("→ Next:"));
}

/** Checked `nextStepLine` — no `→ Next:` line fails the test with a message. */
function mustNextStepLine(stream: string): string {
	const line = nextStepLine(stream);
	if (!line) throw new Error("no → Next: line in output");
	return line;
}

describe("C2: → Next: run X is never a heal loop step (#414)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("audit-with-findings's → Next routes at heal, not audit --fix / classify", async () => {
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(
			join(dir, "design-system/atoms/solo-label.tsx"),
			`export const meta = { kind: 'atom' as const, states: { loading: true } };
export function SoloLabel() { return <span />; }
`,
		);
		const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
		const line = mustNextStepLine(r.stdout);
		expect(line).toContain("claude-ds heal");
		for (const step of LOOP_STEPS) expect(line).not.toContain(step);
	});

	it("doctor with scaffold-gap routes → Next at heal, not the bare loop step", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				packVersion: "v1.4.0",
				pack: "next-react",
				mode: "warn",
				app_dir: "app",
				claude_md_target: ".claude/CLAUDE.md",
			}),
		);
		const r = await runCli(["doctor"], { cwd: dir });
		const line = mustNextStepLine(r.stdout);
		expect(line).toContain("claude-ds heal");
		for (const step of LOOP_STEPS) expect(line).not.toContain(step);
	});

	it("version --check (behind) routes → Next at heal, not the bare upgrade step", async () => {
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({
				version: "v0.5.0",
				pack: "next-react",
				mode: "warn",
			}),
		);
		const r = await runCli(["version", "--check"], { cwd: dir });
		const line = mustNextStepLine(r.stdout);
		expect(line).toContain("claude-ds heal");
		for (const step of LOOP_STEPS) expect(line).not.toContain(step);
	});
});

describe("C3: convergence explainer + labeled passes (#414)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("heal stdout opens with a one-line convergence explainer", async () => {
		await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(
			join(dir, "design-system/atoms/button.tsx"),
			`export function Button() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
		);

		const r = await runCli(["heal"], { cwd: dir });
		// The explainer is the user-visible "what this loop is doing" prose; the
		// matching pin doesn't require the exact word "passes" so the wording can
		// evolve, but it must say "converging" — that's the noun C3 was filed for.
		expect(r.stdout).toMatch(/converging until no drift/i);
	});

	it("heal labels each pass with the steps that pass will run", async () => {
		// Force at least one labeled pass: a corrupt-atom shape that needs work.
		await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
		await writeFile(
			join(dir, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { paths: { "@ds/*": ["./design-system/*"] } } }),
		);
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await mkdir(join(dir, "design-system/composites"), { recursive: true });
		for (const name of ["button", "input", "badge"]) {
			const Name = name[0].toUpperCase() + name.slice(1);
			await writeFile(
				join(dir, `design-system/atoms/${name}.tsx`),
				`export function ${Name}() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
			);
		}
		await writeFile(
			join(dir, "design-system/atoms/combo.tsx"),
			[
				`export function Combo() { return <div><Button/><Input/><Badge/></div>; }`,
				`export const meta = { kind: "atom" as const, examples: [] };`,
				"",
			].join("\n"),
		);

		const r = await runCli(["heal"], { cwd: dir });
		// C3 + #591: a single pass line names its plan and the bound it counts toward
		// (`pass 1/3 (max) — sync → classify → audit --fix`), not a bare counter.
		expect(r.stdout).toMatch(/heal: pass \d+\/\d+ \(max\) — .+( → .+)*/);
		// The driver's bare `pass N/M` double-print is gone (#591).
		expect(r.stdout).not.toMatch(/^pass \d+\/\d+$/m);
	});
});

describe("C4: tier summary by default, --verbose for the per-file list (#414)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

	it("renderChangeTierSummary collapses to a per-tier line, never one-per-file", async () => {
		// Direct render-layer assertion — the implementation contract C4 closes.
		const { renderChangeTierSummary } = await import("../../src/lib/render/index.js");
		const entries = [];
		for (let i = 0; i < 5; i++) {
			entries.push({
				opName: "metaKindFixer",
				change: {
					kind: "write" as const,
					path: `design-system/atoms/atom-${i}.tsx`,
					before: Buffer.from("old\n"),
					after: Buffer.from("new\n"),
				},
			});
		}
		const lines = renderChangeTierSummary(entries);
		expect(lines.length).toBeLessThan(entries.length);
		expect(lines.some((l) => /5 files modified/.test(l))).toBe(true);
		expect(lines.some((l) => /5 atoms\b/.test(l))).toBe(true);
	});
});
