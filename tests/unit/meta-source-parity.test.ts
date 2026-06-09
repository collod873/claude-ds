/**
 * Checker/fixer parity for `meta.kind` (and the `meta.role` twin).
 *
 * Root cause this guards (the Crewops v1.5 "90 unfixable findings" loop):
 * the drift checker/counter read `meta.kind` with a naive
 * `/\bmeta\s*=\s*\{[^}]*\bkind:.../ ` regex whose `[^}]*` stops at the first
 * nested `}`. Any meta whose `kind` sits *after* a nested brace
 * (`examples: [{…}]`, or fields listed before `kind`) read as "missing" to
 * the checker, while the brace-aware *fixer* (`mergeMetaKind`) correctly found
 * the existing `kind` and no-op'd. Same file, opposite verdicts — the
 * `audit --fix` loop reported `0 fixed / N deferred` forever.
 *
 * The invariant: for any source, if the fixer no-ops ("already declares kind")
 * then the checker must agree the kind is present, and vice-versa. They now
 * read through one shared parser, so this is structurally guaranteed; the test
 * pins it against regression.
 */
import { describe, expect, it } from "vitest";
import { mergeMetaKind } from "../../src/lib/drift/merge-meta-kind.js";
import { metaKindFromSource, metaRoleFromSource } from "../../src/lib/three-signal.js";

/** The layouts that broke the old `[^}]*` regex — `kind` after a nested brace. */
const KIND_PRESENT_BUT_NESTED = {
	"examples-before-kind": [
		`export const meta = {`,
		`  examples: [{ name: "Default" }],`,
		`  kind: "atom",`,
		`};`,
	].join("\n"),
	"role + nested props before kind": [
		`export const meta = {`,
		`  role: "button",`,
		`  examples: [{ props: { variant: "x" } }],`,
		`  kind: "composite",`,
		`};`,
	].join("\n"),
	"deeply nested examples before kind": [
		`export const meta = {`,
		`  examples: [{ name: "a", props: { items: [{ id: 1 }] } }],`,
		`  kind: "pattern",`,
		`} as const;`,
	].join("\n"),
};

describe("meta.kind checker/fixer parity", () => {
	for (const [label, src] of Object.entries(KIND_PRESENT_BUT_NESTED)) {
		it(`checker sees kind AND fixer no-ops — ${label}`, () => {
			// Checker: the kind is genuinely present, so it must NOT report missing.
			expect(metaKindFromSource(src)).not.toBeNull();
			// Fixer: the kind is present, so merging any tier must be a no-op.
			expect(mergeMetaKind(src, "atom")).toBe(src);
		});
	}

	it("reads the correct tier from a kind that sits after a nested brace", () => {
		expect(metaKindFromSource(KIND_PRESENT_BUT_NESTED["examples-before-kind"])).toBe("atom");
		expect(metaKindFromSource(KIND_PRESENT_BUT_NESTED["role + nested props before kind"])).toBe(
			"composite",
		);
		expect(metaKindFromSource(KIND_PRESENT_BUT_NESTED["deeply nested examples before kind"])).toBe(
			"pattern",
		);
	});
});

describe("meta.role reader — same nested-brace flaw (the latent twin)", () => {
	it("reads role declared after a nested examples brace", () => {
		const src = [
			`export const meta = {`,
			`  examples: [{ name: "Default", props: { open: true } }],`,
			`  role: "disclosure",`,
			`} as const;`,
		].join("\n");
		expect(metaRoleFromSource(src)).toBe("disclosure");
	});

	it("reads a hyphenated role after nested braces", () => {
		const src = [
			`export const meta = {`,
			`  examples: [{ props: {} }],`,
			`  role: "button-group",`,
			`};`,
		].join("\n");
		expect(metaRoleFromSource(src)).toBe("button-group");
	});
});
