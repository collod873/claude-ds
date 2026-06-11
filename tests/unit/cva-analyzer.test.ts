/**
 * Direct tests for the CVA component-attribution analyzer (issue #552).
 *
 * The analyzer is the keystone deep module of PRD #546: one AST-based truth
 * source that attributes each `cva()` call to the exported component(s) that
 * consume it, with typed values (boolean axes stay boolean). These tests pin
 * its external behavior — the attribution result, never internal call shape.
 */

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeCvaComponents } from "../../src/lib/cva/analyzer.js";

const analyze = (src: string) => analyzeCvaComponents(ts, src, "component.tsx");

describe("analyzeCvaComponents — per-component attribution", () => {
	it("attributes a single body-applied cva() to its exported component", () => {
		const result = analyze(`
import { cva } from "class-variance-authority";
const badge = cva("badge", {
  variants: { size: { sm: "badge-sm", md: "badge-md", lg: "badge-lg" } },
  defaultVariants: { size: "md" },
});
export function Badge({ size }: { size?: "sm" | "md" | "lg" }) {
  return <span className={badge({ size })} />;
}
`);
		expect(Object.keys(result)).toEqual(["Badge"]);
		expect(result.Badge.axes).toEqual({ size: { kind: "enum", values: ["sm", "md", "lg"] } });
		expect(result.Badge.defaultVariants).toEqual({ size: "md" });
	});

	it("attributes via VariantProps<typeof X> in the props type", () => {
		const result = analyze(`
import { cva, type VariantProps } from "class-variance-authority";
const buttonVariants = cva("btn", {
  variants: { tone: { primary: "p", danger: "d" } },
});
interface ButtonProps extends VariantProps<typeof buttonVariants> {}
export function Button(props: ButtonProps) {
  return <button className={buttonVariants(props)} />;
}
`);
		expect(result.Button.axes).toEqual({ tone: { kind: "enum", values: ["primary", "danger"] } });
	});

	it("excludes sub-element axes from the exported component (multi-CVA file)", () => {
		// Mirrors the Crewops break: a sub-element cva() consumed only by a
		// non-exported part must not leak its axes onto the exported component.
		const result = analyze(`
import { cva } from "class-variance-authority";
const triggerVariants = cva("trigger", {
  variants: { density: { compact: "c", cozy: "z" } },
});
function ComboboxTrigger({ density }: { density?: "compact" | "cozy" }) {
  return <button className={triggerVariants({ density })} />;
}
const comboboxVariants = cva("combobox", {
  variants: { size: { sm: "s", lg: "l" } },
});
export function Combobox({ size }: { size?: "sm" | "lg" }) {
  return <div className={comboboxVariants({ size })}><ComboboxTrigger /></div>;
}
`);
		expect(Object.keys(result)).toEqual(["Combobox"]);
		expect(result.Combobox.axes).toEqual({ size: { kind: "enum", values: ["sm", "lg"] } });
		expect(result.Combobox.axes.density).toBeUndefined();
	});

	it("attributes two exported components in one file to their own cva()", () => {
		const result = analyze(`
import { cva } from "class-variance-authority";
const badgeVariants = cva("badge", {
  variants: { variant: { default: "a", secondary: "b" }, size: { sm: "s", md: "m" } },
});
const dotVariants = cva("dot", {
  variants: { color: { green: "g", red: "r" } },
  defaultVariants: { color: "green" },
});
export function Badge({ variant, size }: { variant?: string; size?: string }) {
  return <span className={badgeVariants({ variant, size })} />;
}
export function Dot({ color }: { color?: string }) {
  return <span className={dotVariants({ color })} />;
}
`);
		expect(result.Badge.axes).toEqual({
			variant: { kind: "enum", values: ["default", "secondary"] },
			size: { kind: "enum", values: ["sm", "md"] },
		});
		expect(result.Dot.axes).toEqual({ color: { kind: "enum", values: ["green", "red"] } });
		expect(result.Dot.defaultVariants).toEqual({ color: "green" });
	});

	it("attributes a multi-consumer cva() to each consuming exported component", () => {
		const result = analyze(`
import { cva } from "class-variance-authority";
const shared = cva("base", { variants: { size: { sm: "s", lg: "l" } } });
export function Alpha({ size }: { size?: string }) {
  return <span className={shared({ size })} />;
}
export function Beta({ size }: { size?: string }) {
  return <div className={shared({ size })} />;
}
`);
		expect(result.Alpha.axes).toEqual({ size: { kind: "enum", values: ["sm", "lg"] } });
		expect(result.Beta.axes).toEqual({ size: { kind: "enum", values: ["sm", "lg"] } });
	});
});

describe("analyzeCvaComponents — typed values", () => {
	it("reports a true/false axis as a boolean flag, not string values", () => {
		const result = analyze(`
import { cva } from "class-variance-authority";
const inputVariants = cva("input", {
  variants: {
    invalid: { true: "border-red", false: "border-gray" },
    size: { sm: "s", md: "m" },
  },
  defaultVariants: { invalid: false, size: "md" },
});
export function Input({ invalid, size }: { invalid?: boolean; size?: string }) {
  return <input className={inputVariants({ invalid, size })} />;
}
`);
		expect(result.Input.axes.invalid).toEqual({ kind: "boolean" });
		expect(result.Input.axes.size).toEqual({ kind: "enum", values: ["sm", "md"] });
		expect(result.Input.defaultVariants).toEqual({ invalid: false, size: "md" });
	});
});

describe("analyzeCvaComponents — modifier-prefix immunity", () => {
	it("never surfaces a Tailwind modifier prefix (dark:) as a variant value", () => {
		// The class strings carry `dark:` / `hover:` modifiers. Those live inside
		// value strings, never as axis keys — the AST reads keys only, so they
		// can never leak as a variant value (the old regex bug).
		const result = analyze(`
import { cva } from "class-variance-authority";
const badge = cva("dark:bg-black hover:bg-gray-700", {
  variants: {
    tone: {
      neutral: "dark:bg-zinc-800 hover:bg-zinc-700",
      danger: "dark:bg-red-900 hover:bg-red-800",
    },
  },
});
export function Badge({ tone }: { tone?: string }) {
  return <span className={badge({ tone })} />;
}
`);
		expect(result.Badge.axes.tone).toEqual({ kind: "enum", values: ["neutral", "danger"] });
		const flat = JSON.stringify(result.Badge.axes);
		expect(flat).not.toContain("dark");
		expect(flat).not.toContain("hover");
	});
});

describe("analyzeCvaComponents — no attribution", () => {
	it("returns nothing for a cva() consumed only by a non-exported sub-element", () => {
		const result = analyze(`
import { cva } from "class-variance-authority";
const internalVariants = cva("x", { variants: { size: { sm: "s" } } });
function Internal({ size }: { size?: string }) {
  return <span className={internalVariants({ size })} />;
}
export function Wrapper() {
  return <Internal />;
}
`);
		expect(result.Wrapper).toBeUndefined();
		expect(Object.keys(result)).toEqual([]);
	});

	it("returns an empty record for a file with no cva()", () => {
		const result = analyze(`
export function Plain() {
  return <div />;
}
`);
		expect(result).toEqual({});
	});
});
