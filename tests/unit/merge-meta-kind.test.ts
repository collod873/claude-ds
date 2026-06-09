/**
 * Unit table for `mergeMetaKind` — the A1 deep module that backfills
 * `meta.kind` into an existing `export const meta` declaration instead of
 * appending a duplicate one (PRD #407 / issue #409).
 *
 * Property held by every row: the resulting source contains exactly one
 * top-level `export const meta` declaration, and after the merge that
 * declaration carries the requested `kind`. Existing `examples`/`role`
 * fields are preserved verbatim.
 */
import { describe, expect, it } from "vitest";
import { mergeMetaKind } from "../../src/lib/drift/merge-meta-kind.js";

function countMetaDecls(s: string): number {
	return (s.match(/^export\s+const\s+meta\b/gm) ?? []).length;
}

describe("mergeMetaKind", () => {
	it("emits a fresh declaration when the file has no meta at all", () => {
		const input = `export function Button() { return <button />; }\n`;
		const out = mergeMetaKind(input, "atom");
		expect(countMetaDecls(out)).toBe(1);
		expect(out).toContain('export const meta = { kind: "atom" as const, examples: [] }');
	});

	it("injects kind into a single-line object literal missing kind", () => {
		const input = [
			`export function Spinner() { return <div />; }`,
			`export const meta = { examples: [{ name: "default", props: {} }] };`,
			``,
		].join("\n");
		const out = mergeMetaKind(input, "atom");
		expect(countMetaDecls(out)).toBe(1);
		expect(out).toMatch(/export const meta = \{ kind: "atom" as const, examples: \[/);
		expect(out).toContain(`name: "default"`); // existing examples preserved
	});

	it("injects kind into a typed (`: Meta`) multiline declaration", () => {
		const input = [
			`import type { Meta } from "@/design-system/types/meta";`,
			``,
			`export function Input() { return <input />; }`,
			``,
			`export const meta: Meta = {`,
			`  examples: [`,
			`    { name: "default", props: { value: "" } },`,
			`    { name: "filled", props: { value: "hello" } },`,
			`  ],`,
			`};`,
			``,
		].join("\n");
		const out = mergeMetaKind(input, "atom");
		expect(countMetaDecls(out)).toBe(1);
		expect(out).toContain(`kind: "atom" as const`);
		// existing examples retained verbatim
		expect(out).toContain(`{ name: "filled", props: { value: "hello" } }`);
		// type annotation retained
		expect(out).toMatch(/export const meta: Meta\s*=/);
	});

	it("injects kind into an `as const` multiline declaration", () => {
		const input = [
			`export function Input() { return <input />; }`,
			``,
			`export const meta = {`,
			`  examples: [`,
			`    { name: "default", props: { value: "" } },`,
			`  ],`,
			`} as const;`,
			``,
		].join("\n");
		const out = mergeMetaKind(input, "atom");
		expect(countMetaDecls(out)).toBe(1);
		expect(out).toContain(`kind: "atom" as const`);
		expect(out).toContain(`} as const;`); // trailing `as const` retained
		expect(out).toContain(`name: "default"`);
	});

	it("is a no-op when an existing meta already declares kind", () => {
		const input = [
			`import type { Meta } from "@/design-system/types/meta";`,
			``,
			`export function Button() { return <button />; }`,
			``,
			`export const meta: Meta = {`,
			`  kind: "atom",`,
			`  examples: [`,
			`    { name: "default", props: { label: "click" } },`,
			`  ],`,
			`};`,
			``,
		].join("\n");
		const out = mergeMetaKind(input, "atom");
		expect(countMetaDecls(out)).toBe(1);
		expect(out).toBe(input);
	});

	it("preserves a `role` field alongside the injected kind", () => {
		const input = [
			`export function SearchBox() { return <div />; }`,
			``,
			`export const meta = {`,
			`  role: "combobox",`,
			`  examples: [`,
			`    { name: "default", props: {} },`,
			`  ],`,
			`} as const;`,
			``,
		].join("\n");
		const out = mergeMetaKind(input, "composite");
		expect(countMetaDecls(out)).toBe(1);
		expect(out).toContain(`kind: "composite" as const`);
		expect(out).toContain(`role: "combobox"`);
	});

	it("never produces two `export const meta` declarations across the matrix", () => {
		const tier = "atom" as const;
		const inputs: string[] = [
			// no meta at all
			`export function X() {}\n`,
			// single-line, missing kind
			`export function X() {}\nexport const meta = { examples: [] };\n`,
			// single-line, kind already present
			`export function X() {}\nexport const meta = { kind: "atom", examples: [] };\n`,
			// typed, multiline, missing kind
			`export function X() {}\nexport const meta: Meta = {\n  examples: [],\n};\n`,
			// typed, multiline, kind present
			`export function X() {}\nexport const meta: Meta = {\n  kind: "atom",\n  examples: [],\n};\n`,
			// as const, multiline, missing kind
			`export function X() {}\nexport const meta = {\n  examples: [],\n} as const;\n`,
			// as const, single-line, kind present
			`export function X() {}\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
		];
		for (const input of inputs) {
			const out = mergeMetaKind(input, tier);
			expect(countMetaDecls(out), `input: ${JSON.stringify(input)}`).toBe(1);
		}
	});

	it("inserts kind even when the existing object is empty", () => {
		const input = [`export function X() {}`, `export const meta = {};`, ``].join("\n");
		const out = mergeMetaKind(input, "atom");
		expect(countMetaDecls(out)).toBe(1);
		expect(out).toMatch(/kind:\s*"atom"\s+as\s+const/);
	});

	it("does not mistake the substring `meta_kind_strict` for an export const meta", () => {
		const input = [`export function X() {}`, `const meta_kind_strict = true;`, ``].join("\n");
		const out = mergeMetaKind(input, "atom");
		expect(countMetaDecls(out)).toBe(1); // fresh meta is emitted
		expect(out).toContain("meta_kind_strict = true");
	});

	it("treats nested object literals (examples with `props: {}`) correctly when locating the closing brace", () => {
		// Critical regression case for the A1 defect: the simple
		// `meta\s*=\s*\{[^}]*` regex bails at the first inner `}` from
		// `props: {}`, mis-locates the end of meta, and the fixer falls back to
		// appending — yielding a second `export const meta`. The merge module
		// must walk balanced braces, not stop at the first `}`.
		const input = [
			`import type { Meta } from "@ds/types/meta";`,
			``,
			`export function Input() { return <input />; }`,
			``,
			`export const meta = {`,
			`  examples: [`,
			`    { name: "default", props: { value: "" } },`,
			`    { name: "filled", props: { value: "hello" } },`,
			`  ],`,
			`} as const;`,
			``,
		].join("\n");
		const out = mergeMetaKind(input, "atom");
		expect(countMetaDecls(out)).toBe(1);
		expect(out).toContain(`kind: "atom" as const`);
	});

	it("recognises a typed declaration whose annotation contains a generic (`: Meta<Props>`)", () => {
		const input = [
			`export function X() {}`,
			`export const meta: Meta<{ label: string }> = {`,
			`  examples: [],`,
			`};`,
			``,
		].join("\n");
		const out = mergeMetaKind(input, "atom");
		expect(countMetaDecls(out)).toBe(1);
		expect(out).toContain(`kind: "atom" as const`);
	});
});
