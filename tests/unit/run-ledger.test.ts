/**
 * The heal run ledger (PRD #575 / #579). The ledger accumulates every step's
 * writes across the passes of the remediation loop and renders a deduplicated,
 * grouped inventory of what heal wrote — the blast-radius answer the failure
 * output needs.
 *
 * This suite feeds the ledger synthetic `RunReport`s directly (the public
 * `record` interface), across multiple passes, and asserts the grouped /
 * deduplicated rendering. It makes no assertions on the driver — the driver
 * wiring (ledger carried on the outcome) is exercised through the driver suite.
 */
import { describe, expect, it } from "vitest";
import { createRunLedger } from "../../src/lib/run-ledger";
import type { Change, RunReport } from "../../src/lib/runner";

function report(...applied: Change[]): RunReport {
	return { ops: [], applied };
}
const write = (path: string): Change => ({
	kind: "write",
	path,
	before: null,
	after: Buffer.from("x"),
});
const del = (path: string): Change => ({ kind: "delete", path, before: Buffer.from("x") });
const rename = (path: string, after: string): Change => ({ kind: "rename", path, after });
const abort = (path: string): Change => ({ kind: "abort", path, reason: "hand-edited" });

describe("run ledger", () => {
	it("records write / delete / rename verbs from a report", () => {
		const ledger = createRunLedger();
		ledger.record("sync", report(write("a.tsx"), del("b.tsx"), rename("c.tsx", "d.tsx")));

		expect(ledger.entries()).toEqual([
			{ step: "sync", verb: "write", path: "a.tsx" },
			{ step: "sync", verb: "delete", path: "b.tsx" },
			{ step: "sync", verb: "rename", path: "c.tsx", toPath: "d.tsx" },
		]);
	});

	it("excludes abort changes — an abort wrote nothing", () => {
		const ledger = createRunLedger();
		ledger.record("sync", report(abort("managed.tsx"), write("real.tsx")));

		expect(ledger.entries()).toEqual([{ step: "sync", verb: "write", path: "real.tsx" }]);
	});

	it("deduplicates by path across passes — last verb wins", () => {
		const ledger = createRunLedger();
		// Pass 1: sync writes the file.
		ledger.record("sync", report(write("design-system/atoms/button.tsx")));
		// Pass 3: audit --fix rewrites the same file. One entry, the last verb/step win.
		ledger.record("audit --fix", report(write("design-system/atoms/button.tsx")));

		expect(ledger.entries()).toEqual([
			{ step: "audit --fix", verb: "write", path: "design-system/atoms/button.tsx" },
		]);
	});

	it("a write later deleted collapses to a single delete entry", () => {
		const ledger = createRunLedger();
		ledger.record("sync", report(write("tmp.tsx")));
		ledger.record("audit --fix", report(del("tmp.tsx")));

		expect(ledger.entries()).toEqual([{ step: "audit --fix", verb: "delete", path: "tmp.tsx" }]);
	});

	it("a rename of a previously-written path is one entry with old → new", () => {
		const ledger = createRunLedger();
		// Pass 1: the file is written under its original path.
		ledger.record("sync", report(write("design-system/atoms/old.tsx")));
		// Pass 2: classify relocates it — a single rename Change, not delete+create.
		ledger.record(
			"classify",
			report(rename("design-system/atoms/old.tsx", "design-system/composites/new.tsx")),
		);

		expect(ledger.entries()).toEqual([
			{
				step: "classify",
				verb: "rename",
				path: "design-system/atoms/old.tsx",
				toPath: "design-system/composites/new.tsx",
			},
		]);
	});

	it("renders a grouped-by-step inventory", () => {
		const ledger = createRunLedger();
		ledger.record("sync", report(write("design-system/atoms/button.tsx")));
		ledger.record(
			"classify",
			report(rename("design-system/atoms/old.tsx", "design-system/composites/new.tsx")),
		);
		ledger.record("audit --fix", report(del("design-system/atoms/stale.tsx")));

		expect(ledger.render()).toBe(
			[
				"sync:",
				"  write design-system/atoms/button.tsx",
				"classify:",
				"  rename design-system/atoms/old.tsx → design-system/composites/new.tsx",
				"audit --fix:",
				"  delete design-system/atoms/stale.tsx",
			].join("\n"),
		);
	});

	it("groups a file under the step that last touched it, not where it started", () => {
		const ledger = createRunLedger();
		ledger.record("sync", report(write("shared.tsx")));
		ledger.record("audit --fix", report(write("shared.tsx"), write("other.tsx")));

		// `shared.tsx` last written by audit --fix → it groups under audit, once.
		expect(ledger.render()).toBe(
			["audit --fix:", "  write shared.tsx", "  write other.tsx"].join("\n"),
		);
	});

	it("renders empty when nothing was written", () => {
		const ledger = createRunLedger();
		ledger.record("sync", report());
		ledger.record("audit --fix", report(abort("managed.tsx")));

		expect(ledger.entries()).toEqual([]);
		expect(ledger.render()).toBe("");
	});
});
