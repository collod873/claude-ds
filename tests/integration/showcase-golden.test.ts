/**
 * Golden / anti-ping-pong test for the promoted showcase generator (issue #567).
 *
 * The CLI's in-process emission path (`src/lib/showcase/generator.ts`) must be
 * BYTE-IDENTICAL to the pack script's emission
 * (`packs/next-react/files/scripts/generate-showcase-companion.ts`) for the same
 * source. If they ever diverge, heal's generated-integrity check would rewrite a
 * consumer's pack-generated showcase on every run — the ping-pong "never break a
 * consumer" forbids. The pack script is untouched in this slice; this test is the
 * contract that lets a later slice reduce it to a shim.
 *
 * Covers the four shapes the acceptance criteria call out: a multi-cva file
 * (attribution scoping), a boolean axis (`{true}`/`{false}`), an acronym /
 * default-export, and externally-typed props (cross-example required-prop
 * completion).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateShowcase } from "../../src/lib/showcase/generator.js";

const SCRIPT = resolve("packs/next-react/files/scripts/generate-showcase-companion.ts");

/** kebab basename → component source text seeded under design-system/atoms. */
const FIXTURES: Record<string, string> = {
	// ── multi-cva file: two cva() defs; the primary component consumes one, a
	// non-exported sub-element consumes the other (attribution must scope to the
	// component the showcase renders, never the file-wide union). ──
	"multi-card": [
		`import React from "react";`,
		`import { cva } from "class-variance-authority";`,
		`const cardVariants = cva("card", {`,
		`  variants: { tone: { primary: "p", muted: "m" }, size: { sm: "s", lg: "l" } },`,
		`  defaultVariants: { tone: "primary", size: "sm" },`,
		`});`,
		`const iconVariants = cva("icon", {`,
		`  variants: { spin: { true: "animate-spin", false: "" } },`,
		`  defaultVariants: { spin: false },`,
		`});`,
		`function CardIcon({ spin }: { spin?: boolean }) { return <span className={iconVariants({ spin })} />; }`,
		`export function MultiCard({ tone, size, ...props }: { tone?: "primary" | "muted"; size?: "sm" | "lg" }) {`,
		`  return <div className={cardVariants({ tone, size })} {...props}><CardIcon /></div>;`,
		`}`,
		`export const meta = { kind: "atom", examples: [{ name: "default", props: { tone: "primary" } }], skip: [] };`,
		``,
	].join("\n"),

	// ── boolean axis: a `{ true, false }` axis exposed as a prop must emit
	// `{true}`/`{false}` JSX expressions, never the strings "true"/"false". ──
	"toggle-field": [
		`import React from "react";`,
		`import { cva } from "class-variance-authority";`,
		`const fieldVariants = cva("field", {`,
		`  variants: { invalid: { true: "border-danger", false: "border-muted" }, size: { sm: "s", md: "m" } },`,
		`  defaultVariants: { invalid: false, size: "md" },`,
		`});`,
		`export function ToggleField({ invalid, size, ...props }: { invalid?: boolean; size?: "sm" | "md" }) {`,
		`  return <input data-invalid={invalid} className={fieldVariants({ invalid, size })} {...props} />;`,
		`}`,
		`export const meta = { kind: "atom", examples: [{ name: "flagged", props: { invalid: true } }], skip: [] };`,
		``,
	].join("\n"),

	// ── acronym / default-export: short acronym name (toPascalCase("kpi") =
	// "Kpi") exported as default → exercises the default-import selection rule. ──
	kpi: [
		`import React from "react";`,
		`export default function Kpi({ label, value }: { label: string; value: string }) {`,
		`  return <div><span>{label}</span><strong>{value}</strong></div>;`,
		`}`,
		`export const meta = { kind: "atom", examples: [{ name: "filled", props: { label: "MRR", value: "42" } }], skip: [] };`,
		``,
	].join("\n"),

	// ── externally-typed props: the required `value` lives in an external package
	// type the syntactic walk can't resolve; the only evidence is that every other
	// authored example carries it (cross-example consensus completion, ADR-0030). ──
	"ext-slider": [
		`import React from "react";`,
		`import { Slider as SliderPrimitive } from "@fake-ui/react/slider";`,
		`import { cva } from "class-variance-authority";`,
		`const sliderVariants = cva("slider", {`,
		`  variants: { size: { sm: "s", default: "d" } },`,
		`  defaultVariants: { size: "default" },`,
		`});`,
		`type SliderProps = SliderPrimitive.Root.Props & { size?: "sm" | "default" };`,
		`export function ExtSlider({ size, ...props }: SliderProps) {`,
		`  return <div className={sliderVariants({ size })} {...props} />;`,
		`}`,
		`export const meta = { kind: "atom", examples: [`,
		`  { name: "size=default", props: { value: "v-one" } },`,
		`  { name: "size=sm", props: { size: "sm", value: "v-two" } },`,
		`  { name: "default", props: { size: "default" } },`,
		`], skip: [] };`,
		``,
	].join("\n"),

	// ── "use client" directive: a leading client directive must survive verbatim
	// onto the first line of the emitted showcase (Next.js client-component
	// requirement). Exercises the `useClientLine` prefix the four atom fixtures
	// above don't. ──
	"client-badge": [
		`"use client";`,
		`import React from "react";`,
		`import { cva } from "class-variance-authority";`,
		`const badgeVariants = cva("badge", {`,
		`  variants: { tone: { info: "i", warn: "w" } },`,
		`  defaultVariants: { tone: "info" },`,
		`});`,
		`export function ClientBadge({ tone, ...props }: { tone?: "info" | "warn" }) {`,
		`  return <span className={badgeVariants({ tone })} {...props} />;`,
		`}`,
		`export const meta = { kind: "atom", examples: [{ name: "default", props: { tone: "info" } }], skip: [] };`,
		``,
	].join("\n"),

	// ── reference kind: a doc page rendered via `meta.render()` rather than the
	// component itself — a wholly separate emitter (`emitReferenceShowcase`) the
	// atom/composite fixtures never reach. ──
	"tokens-ref": [
		`import React from "react";`,
		`export const meta = {`,
		`  kind: "reference" as const,`,
		`  title: "Design Tokens",`,
		`  render: () => <div className="tokens">swatches</div>,`,
		`};`,
		``,
	].join("\n"),
};

describe("showcase generator — CLI emission is byte-identical to the pack script (#567)", () => {
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "showcase-golden-"));
		// package.json so both findConsumerRoot() implementations resolve the same
		// project root (and read no tsconfig — neither fixture uses @/ aliases).
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ name: "golden-consumer" }, null, 2),
		);
		const atomsDir = join(dir, "design-system", "atoms");
		await mkdir(atomsDir, { recursive: true });
		for (const [name, source] of Object.entries(FIXTURES)) {
			await writeFile(join(atomsDir, `${name}.tsx`), source);
		}
		// One spawn generates every companion; each fixture reads only its own.
		const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
			cwd: dir,
			encoding: "utf8",
		});
		expect(r.status, r.stderr).toBe(0);
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	for (const name of Object.keys(FIXTURES)) {
		it(`${name}: CLI module output matches the pack script byte-for-byte`, async () => {
			const sourcePath = join(dir, "design-system", "atoms", `${name}.tsx`);
			const showcasePath = join(dir, "design-system", "atoms", `${name}.showcase.tsx`);
			expect(existsSync(showcasePath), `pack script did not emit ${name}.showcase.tsx`).toBe(true);

			const packBytes = await readFile(showcasePath, "utf8");
			const source = await readFile(sourcePath, "utf8");
			const cli = generateShowcase({ filePath: sourcePath, source });

			expect(cli.skipReason).toBeNull();
			expect(cli.content).toBe(packBytes);
		});
	}
});
