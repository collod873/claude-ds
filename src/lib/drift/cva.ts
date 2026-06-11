import * as ts from "typescript";

import { analyzeCvaComponents, type CvaAxis } from "../cva/analyzer.js";

export type { CvaAxis } from "../cva/analyzer.js";

/**
 * Pseudo-state axes (hover, focus, dark, …) are CSS state selectors expressed as
 * CVA boolean axes, not props the showcase enumerates as examples. The analyzer
 * reports them like any other axis (it reads keys structurally); the fixer layer
 * filters them so the CVA-unrendered rule never demands a `hover=true` example.
 */
const PSEUDO_STATE_AXES = new Set([
	"hover",
	"focus",
	"active",
	"disabled",
	"checked",
	"selected",
	"visited",
	"pressed",
	"expanded",
	"visible",
	"open",
	"closed",
	"dark",
	"light",
	"focusVisible",
	"focusWithin",
]);

/**
 * Variant axes attributed to the file's exported component(s), keyed by axis
 * name, with typed values (`{ kind: "enum"; values }` | `{ kind: "boolean" }`).
 *
 * Backed by the AST component-attribution analyzer (`src/lib/cva/analyzer.ts`,
 * issues #552/#554) — the file-wide regex parser is gone. Two consequences the
 * fixers rely on: a sub-element `cva()` consumed only by a non-exported part
 * never leaks its axes onto the exported component (so `audit --fix` stops
 * writing props the component never accepted), and a `true`/`false` axis stays
 * boolean (so meta examples land as `{ invalid: true }`, not `{ invalid: "true" }`).
 *
 * Pseudo-state axes are filtered. Axes shared across several exported components
 * are de-duplicated by name (first attribution wins).
 *
 * Shared by the CVA-unrendered rule (detect + fix) and the raw-primitive fixer
 * (which parses the atom's own source to infer a variant prop).
 */
export function attributedAxes(source: string): Map<string, CvaAxis> | null {
	if (!source.includes("cva(")) return null;

	const attribution = analyzeCvaComponents(ts, source);
	const axes = new Map<string, CvaAxis>();
	for (const component of Object.values(attribution)) {
		for (const [name, axis] of Object.entries(component.axes)) {
			if (PSEUDO_STATE_AXES.has(name)) continue;
			if (!axes.has(name)) axes.set(name, axis);
		}
	}
	return axes.size > 0 ? axes : null;
}

/**
 * Enum axes only, as a plain `axisName -> values[]` map — the shape the
 * raw-primitive fixer's per-instance className inference consumes. Boolean axes
 * carry no string class value to match against a className, so they're excluded.
 */
export function attributedEnumVariants(source: string): Record<string, string[]> | null {
	const axes = attributedAxes(source);
	if (!axes) return null;

	const result: Record<string, string[]> = {};
	for (const [name, axis] of axes) {
		if (axis.kind === "enum") result[name] = axis.values;
	}
	return Object.keys(result).length > 0 ? result : null;
}
