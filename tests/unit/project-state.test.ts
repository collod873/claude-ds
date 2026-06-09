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

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { deriveProjectState } from "../../src/lib/project-state.js";
import { planRemediation } from "../../src/lib/remediation-planner.js";
import { cleanup, freshTmpDir } from "../helpers/tmpdir.js";

const BASE_CFG = {
	pack: "next-react",
	mode: "warn",
	domain_roots: ["features", "lib"],
	ds_aliases: ["@ds"],
};

describe("deriveProjectState", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await freshTmpDir();
	});
	afterEach(async () => {
		await cleanup(dir);
	});

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

	it("DRIFT-MISCLASSIFIED-ATOM (unfixable + classifyRelocatable) → classifyNeeded, not unresolvableFindings (#379)", async () => {
		// The canonical 'unfixable but classify can relocate it' case. The
		// deriver must keep routing these to `classifyNeeded` so the planner
		// emits `classify`. Asserting BOTH halves of the new split — the
		// positive (classifyNeeded fires) and the negative (unresolvable does
		// NOT) — pins that the relocatable arm doesn't accidentally also tip
		// the unresolvable signal.
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({ ...BASE_CFG, packVersion: `v${pkg.version}` }),
		);
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		// meta.kind=atom but classifier confidently calls it composite. Three
		// DS imports clears `COMPOSITE_CONFIDENCE_THRESHOLD` (classifier.ts:28)
		// so the verdict is non-ambiguous — both MISPLACED and
		// MISCLASSIFIED-ATOM fire, both classifyRelocatable=true.
		await writeFile(
			join(dir, "design-system/atoms/leaf-a.tsx"),
			`export function LeafA() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
		);
		await writeFile(
			join(dir, "design-system/atoms/leaf-b.tsx"),
			`export function LeafB() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
		);
		await writeFile(
			join(dir, "design-system/atoms/leaf-c.tsx"),
			`export function LeafC() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
		);
		await writeFile(
			join(dir, "design-system/atoms/composes-others.tsx"),
			`import { LeafA } from "@/design-system/atoms/leaf-a";
import { LeafB } from "@/design-system/atoms/leaf-b";
import { LeafC } from "@/design-system/atoms/leaf-c";
export function ComposesOthers() { return <div><LeafA/><LeafB/><LeafC/></div>; }
export const meta = { kind: "atom" as const, examples: [] };
`,
		);
		const state = await deriveProjectState(dir);
		expect(state.classifyNeeded).toBe(true);
		expect(state.unresolvableFindings).toBe(false);
	});

	it("DRIFT-ROLE-NO-CONTRACT (unfixable + !classifyRelocatable) → unresolvableFindings, not classifyNeeded (#379)", async () => {
		// The motivating case from the #378 review: an unfixable rule classify
		// also cannot remedy. The previous deriver folded it into
		// `classifyNeeded`, which let the convergence check stay correct only
		// because today's unfixable rules happen to be classify-owned — but
		// for ROLE-NO-CONTRACT classify has no code path. The deriver must now
		// route it to `unresolvableFindings` so heal cannot silently declare
		// convergence while a real finding remains, while ALSO not lying that
		// classify has work to do.
		//
		// ROLE-NO-CONTRACT is the cleanest isolation: a tabs atom with
		// meta.role="tabs" (no shipped contract) fires ROLE-NO-CONTRACT and
		// nothing else — placement matches, classifier verdict matches, no
		// PATTERN- rules apply. Other !classifyRelocatable rules
		// (PATTERN-IMPORTS-PATTERN, PATTERN-NO-SLOTS) co-fire with MISPLACED
		// because the classifier can't return tier=pattern for a pattern file
		// that imports another pattern or lacks slot exports, so isolating
		// them at this layer would also require fixing that classifier gap.
		await writeFile(
			join(dir, ".claude-ds.json"),
			JSON.stringify({ ...BASE_CFG, packVersion: `v${pkg.version}` }),
		);
		await mkdir(join(dir, "design-system/atoms"), { recursive: true });
		await writeFile(
			join(dir, "design-system/atoms/tabs.tsx"),
			`export function Tabs() { return <div/>; }
export const meta = { kind: "atom" as const, role: "tabs" as const, examples: [] };
`,
		);
		const state = await deriveProjectState(dir);
		expect(state.unresolvableFindings).toBe(true);
		expect(state.classifyNeeded).toBe(false);
		// Convergence-check parity: the driver consults
		// `classifyNeeded || autoFixNeeded || unresolvableFindings`, so this
		// state still forces a loud "did not converge" exit instead of a
		// silent success.
		expect(state.classifyNeeded || state.autoFixNeeded || state.unresolvableFindings).toBe(true);
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
