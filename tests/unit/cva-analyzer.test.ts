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
import {
	analyzeCvaComponents,
	collectExportedComponentNames,
	collectFileCvaAxes,
	collectRequiredPropNames,
	cvaUnresolvedPropsDiagnostics,
} from "../../src/lib/cva/analyzer.js";

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

	it("attributes a forwardRef-wrapped component via its body usage", () => {
		// The dominant shadcn atom shape: the props type rides the forwardRef
		// generics, not a param annotation, so attribution must come from the body.
		const result = analyze(`
import { cva } from "class-variance-authority";
import * as React from "react";
const buttonVariants = cva("btn", { variants: { tone: { primary: "p", danger: "d" } } });
export const Button = React.forwardRef<HTMLButtonElement, { tone?: "primary" | "danger" }>(
  ({ tone }, ref) => <button ref={ref} className={buttonVariants({ tone })} />,
);
`);
		expect(Object.keys(result)).toEqual(["Button"]);
		expect(result.Button.axes).toEqual({ tone: { kind: "enum", values: ["primary", "danger"] } });
	});

	it("attributes a forwardRef component via VariantProps in its type argument", () => {
		// Props applied through a spread, so the body never names the cva — the only
		// signal is `VariantProps<typeof X>` carried as forwardRef's props type arg.
		const result = analyze(`
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";
const inputVariants = cva("input", { variants: { size: { sm: "s", lg: "l" } } });
type InputProps = VariantProps<typeof inputVariants>;
export const Input = forwardRef<HTMLInputElement, InputProps>((props, ref) => (
  <input ref={ref} className={String(props.size)} />
));
`);
		expect(result.Input.axes).toEqual({ size: { kind: "enum", values: ["sm", "lg"] } });
	});

	it("attributes a memo-wrapped component", () => {
		const result = analyze(`
import { cva } from "class-variance-authority";
import { memo } from "react";
const cardVariants = cva("card", { variants: { density: { compact: "c", cozy: "z" } } });
export const Card = memo(function Card({ density }: { density?: string }) {
  return <div className={cardVariants({ density })} />;
});
`);
		expect(result.Card.axes).toEqual({ density: { kind: "enum", values: ["compact", "cozy"] } });
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

describe("analyzeCvaComponents — axis exposure (canary regression, v1.8.2)", () => {
	it("drops an axis the component consumes internally but never accepts as a prop", () => {
		// Crewops input.tsx: `invalid` is driven by the `aria-invalid` prop, never
		// accepted as `invalid`. Body usage consumes the cva, but only `size` is a
		// real prop — emitting `<Input invalid={true}>` fails the consumer's tsc.
		const result = analyze(`
import { cva } from "class-variance-authority";
export const inputVariants = cva("input", {
  variants: {
    size: { sm: "s", md: "m" },
    invalid: { true: "border-red", false: "border-gray" },
  },
  defaultVariants: { size: "md", invalid: false },
});
export function Input({ size = "md", "aria-invalid": ariaInvalid, ...props }: { size?: "sm" | "md"; "aria-invalid"?: boolean }) {
  const isInvalid = ariaInvalid === true;
  return <input className={inputVariants({ size, invalid: isInvalid })} {...props} />;
}
`);
		expect(result.Input.axes).toEqual({ size: { kind: "enum", values: ["sm", "md"] } });
		expect(result.Input.axes.invalid).toBeUndefined();
		expect(result.Input.defaultVariants).toEqual({ size: "md" });
	});

	it("respects Omit<VariantProps<typeof x>, …> — excluded axes are not props", () => {
		// Crewops avatar.tsx: props spread the cva's VariantProps but Omit `kind`,
		// which the component derives internally.
		const result = analyze(`
import { cva, type VariantProps } from "class-variance-authority";
const avatarRoot = cva("avatar", {
  variants: { size: { sm: "s", lg: "l" }, kind: { image: "i", initials: "n" } },
});
type AvatarProps = Omit<VariantProps<typeof avatarRoot>, "kind"> & { src?: string };
export function Avatar({ size, src }: AvatarProps) {
  return <span className={avatarRoot({ size, kind: src ? "image" : "initials" })} />;
}
`);
		expect(result.Avatar.axes).toEqual({ size: { kind: "enum", values: ["sm", "lg"] } });
		expect(result.Avatar.axes.kind).toBeUndefined();
	});

	it("respects Omit<VariantProps<typeof x>, …> in a heritage clause", () => {
		// Same Avatar shape as above, but `interface … extends Omit<…>` instead of
		// a type-alias intersection: heritage clauses reference types as
		// expressions, and the Omit keys must still carry into the spread.
		const result = analyze(`
import { cva, type VariantProps } from "class-variance-authority";
const avatarRoot = cva("avatar", {
  variants: { size: { sm: "s", lg: "l" }, kind: { image: "i", initials: "n" } },
});
interface AvatarProps extends Omit<VariantProps<typeof avatarRoot>, "kind"> {
  src?: string;
}
export function Avatar({ size, src }: AvatarProps) {
  return <span className={avatarRoot({ size, kind: src ? "image" : "initials" })} />;
}
`);
		expect(result.Avatar.axes).toEqual({ size: { kind: "enum", values: ["sm", "lg"] } });
		expect(result.Avatar.axes.kind).toBeUndefined();
	});

	it("resolves a locally-declared base interface referenced from a heritage clause", () => {
		// `interface Props extends BaseProps` — the base's members are props even
		// though the body consumes the axis with a literal, never reading it.
		const result = analyze(`
import { cva } from "class-variance-authority";
const chip = cva("chip", { variants: { size: { sm: "s", lg: "l" } } });
type BaseProps = { size?: "sm" | "lg" };
interface ChipProps extends BaseProps {
  label?: string;
}
export function Chip(props: ChipProps) {
  return <span className={chip({ size: props.label ? "lg" : "sm" })} />;
}
`);
		expect(result.Chip.axes).toEqual({ size: { kind: "enum", values: ["sm", "lg"] } });
	});

	it("does not surface a nested object member as top-level prop exposure", () => {
		// `config`'s own type has a `size` member; the component accepts only
		// `config`. Descending into member types would claim `size` as a prop and
		// emit `<Thing size="sm">`, which the consumer's tsc rejects.
		const result = analyze(`
import { cva } from "class-variance-authority";
const v = cva("thing", { variants: { size: { sm: "s", md: "m" } } });
type Opt = { size: string };
type ThingProps = { config?: Opt };
export function Thing(props: ThingProps) {
  return <div className={v({ size: "sm" })} />;
}
`);
		expect(result.Thing).toBeUndefined();
	});

	it("collects exposure from reads off a destructuring rest binding", () => {
		// Externally-typed props (unresolvable locally) read via `rest.variant` /
		// `rest.size`: every key read off the rest binding is a caller prop, the
		// same way `props.x` is.
		const result = analyze(`
import { cva } from "class-variance-authority";
import type { ButtonProps } from "./button.types";
export const buttonVariants = cva("btn", {
  variants: { variant: { primary: "p", ghost: "g" }, size: { sm: "s", lg: "l" } },
});
export function Button({ className, ...rest }: ButtonProps) {
  return <button className={buttonVariants({ variant: rest.variant, size: rest.size })} />;
}
`);
		expect(result.Button.axes).toEqual({
			variant: { kind: "enum", values: ["primary", "ghost"] },
			size: { kind: "enum", values: ["sm", "lg"] },
		});
	});

	it("does not treat an indexed-access value-type alias as a wholesale props spread", () => {
		// Crewops combobox.tsx: `type Size = NonNullable<VariantProps<typeof v>["size"]>`
		// extracts ONE axis's value type. The `typeof v` inside it must not expose
		// every axis; only the member that uses the alias is a prop.
		const result = analyze(`
import { cva, type VariantProps } from "class-variance-authority";
export const triggerVariants = cva("trigger", {
  variants: {
    size: { sm: "s", lg: "l" },
    invalid: { true: "t", false: "f" },
  },
});
type TriggerSize = NonNullable<VariantProps<typeof triggerVariants>["size"]>;
type TriggerProps = { size?: TriggerSize; placeholder?: string };
export function ComboboxTrigger({ size = "sm", placeholder, ...props }: TriggerProps) {
  const invalid = false;
  return <button className={triggerVariants({ size, invalid })} {...props} />;
}
`);
		expect(result.ComboboxTrigger.axes).toEqual({
			size: { kind: "enum", values: ["sm", "lg"] },
		});
		expect(result.ComboboxTrigger.axes.invalid).toBeUndefined();
	});

	it("attributes an exported cva consumed only by a non-exported sub-component to no one", () => {
		// Crewops combobox.tsx root shape: the cva const itself is exported, but the
		// only component applying it is non-exported. Exporting the cva must not
		// attribute its axes to the file's other exported components.
		const result = analyze(`
import { cva } from "class-variance-authority";
export const triggerVariants = cva("trigger", {
  variants: { size: { sm: "s", lg: "l" } },
});
function Trigger({ size }: { size?: "sm" | "lg" }) {
  return <button className={triggerVariants({ size })} />;
}
export function Combobox({ children }: { children?: unknown }) {
  return <div><Trigger /></div>;
}
`);
		expect(result.Combobox).toBeUndefined();
		expect(Object.keys(result)).toEqual([]);
	});
});

describe("collectFileCvaAxes — file-wide axis surface", () => {
	it("unions every cva definition's axes regardless of attribution", () => {
		const source = `
import { cva } from "class-variance-authority";
const a = cva("a", { variants: { size: { sm: "s" } } });
const b = cva("b", { variants: { invalid: { true: "t", false: "f" } } });
export function Root({ children }: { children?: unknown }) { return <div />; }
`;
		expect(collectFileCvaAxes(ts, source)).toEqual({
			size: { kind: "enum", values: ["sm"] },
			invalid: { kind: "boolean" },
		});
	});

	it("returns an empty record for a file with no cva()", () => {
		expect(collectFileCvaAxes(ts, "export function Plain() { return <div />; }")).toEqual({});
	});
});

describe("collectRequiredPropNames", () => {
	it("reports top-level members without `?`, resolving a local props type", () => {
		// The Crewops radio shape: `value` required, `size` optional.
		const source = `
import { cva } from "class-variance-authority";
const v = cva("radio", { variants: { size: { sm: "s", default: "d" } } });
type RadioProps = { value: string; size?: "sm" | "default" };
export function Radio({ value, size }: RadioProps) {
  return <input value={value} className={v({ size })} />;
}
`;
		expect([...collectRequiredPropNames(ts, source, ["Radio"])]).toEqual(["value"]);
	});

	it("respects Omit<> and never descends into a member's own type", () => {
		const source = `
type Base = { id: string; config: { mode: string }; label?: string };
type Props = Omit<Base, "id">;
export function Card(props: Props) { return <div />; }
`;
		const required = collectRequiredPropNames(ts, source, ["Card"]);
		expect(required.has("config")).toBe(true);
		expect(required.has("id")).toBe(false); // Omit'd away
		expect(required.has("mode")).toBe(false); // nested member, not a prop
		expect(required.has("label")).toBe(false); // optional
	});

	it("only reports a member required in EVERY union alternative", () => {
		// Crewops Badge: `({ status: S; tone?: never } | { status?: never; tone?: T })`
		// — `status` is required in one alternative only, so injecting it into a
		// tone-keyed example breaks the discriminated union. `value` (required in
		// both alternatives) survives; the intersection base's `id` survives.
		const source = `
type P = { id: string } & (
  | { value: string; status: "draft" | "paid"; tone?: never }
  | { value: string; status?: never; tone?: "neutral" | "danger" }
);
export function Badge(props: P) { return <span />; }
`;
		const required = collectRequiredPropNames(ts, source, ["Badge"]);
		expect(required.has("id")).toBe(true);
		expect(required.has("value")).toBe(true);
		expect(required.has("status")).toBe(false);
		expect(required.has("tone")).toBe(false);
	});

	it("respects Omit<> in a heritage clause", () => {
		const source = `
type Base = { value: string; label?: string };
interface Props extends Omit<Base, "value"> {
  id: string;
}
export function Field(props: Props) { return <div />; }
`;
		const required = collectRequiredPropNames(ts, source, ["Field"]);
		expect(required.has("id")).toBe(true);
		expect(required.has("value")).toBe(false); // Omit'd away in the heritage clause
	});

	it("returns nothing for an unresolvable or absent props type", () => {
		const source = `export function Loose(props: any) { return <div />; }`;
		expect(collectRequiredPropNames(ts, source, ["Loose"]).size).toBe(0);
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

describe("source-keyed parse memo", () => {
	// A detect+fix cycle drives several entry points over the same atom source;
	// they must collectively parse it once. Instrument the injected compiler's
	// createSourceFile rather than asserting any production-path internal.
	it("parses identical source once across repeated analyzer entry-point calls", () => {
		let parses = 0;
		const counting = new Proxy(ts, {
			get(target, prop, receiver) {
				if (prop === "createSourceFile") {
					return (...args: Parameters<typeof ts.createSourceFile>) => {
						parses++;
						return ts.createSourceFile(...args);
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		}) as typeof ts;

		// Unique to this test so the process-global memo cannot collide with
		// another test's fixture (or be pre-warmed by one).
		const fileName = "parse-memo-fixture.tsx";
		const source = `
import { cva, type VariantProps } from "class-variance-authority";
const memoBadge = cva("badge", {
  variants: { size: { sm: "s", md: "m" } },
  defaultVariants: { size: "md" },
});
export function MemoBadge(props: VariantProps<typeof memoBadge>) {
  return <span className={memoBadge(props)} />;
}
`;

		analyzeCvaComponents(counting, source, fileName);
		analyzeCvaComponents(counting, source, fileName);
		collectFileCvaAxes(counting, source, fileName);
		collectExportedComponentNames(counting, source, fileName);
		cvaUnresolvedPropsDiagnostics(counting, source, fileName);
		collectRequiredPropNames(counting, source, ["MemoBadge"], fileName);

		expect(parses).toBe(1);
	});
});
