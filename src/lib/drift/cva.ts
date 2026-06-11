import { basename } from "node:path";

import * as ts from "typescript";

import { analyzeCvaComponents, type CvaAxis } from "../cva/analyzer.js";
// The primary-component selection rule and its `toPascalCase` display-name
// derivation live in the showcase generator (issue #567) — the single module
// that owns them, matching the generator's own render-target selection. Both
// the CVA-consuming fixers (via `primaryComponent` below) and the generator
// delegate here, so they can never disagree on which export a file showcases.
import { primaryComponent } from "../showcase/generator.js";

export type { CvaAxis } from "../cva/analyzer.js";
// Re-exported so `meta-examples-invalid-prop` keeps importing the selection rule
// from here unchanged; `primaryComponent` is also used directly below.
export { primaryComponent, primaryComponentNames } from "../showcase/generator.js";

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
 * Variant axes attributed to the file's PRIMARY component (the one its showcase
 * renders — see `primaryComponent`), keyed by axis name, with typed values
 * (`{ kind: "enum"; values }` | `{ kind: "boolean" }`).
 *
 * Backed by the AST component-attribution analyzer (`src/lib/cva/analyzer.ts`,
 * issues #552/#554) — the file-wide regex parser is gone. Two consequences the
 * fixers rely on: a sub-element `cva()`'s axes never leak onto the showcased
 * component (so `audit --fix` stops writing props it never accepted), and a
 * `true`/`false` axis stays boolean (so meta examples land as
 * `{ invalid: true }`, not `{ invalid: "true" }`).
 *
 * Pseudo-state axes are filtered.
 *
 * Shared by the CVA-unrendered rule (detect + fix) and the raw-primitive fixer
 * (which parses the atom's own source to infer a variant prop).
 */
export function attributedAxes(source: string, file: string): Map<string, CvaAxis> | null {
	if (!source.includes("cva(")) return null;

	const component = primaryComponent(analyzeCvaComponents(ts, source, basename(file)), file);
	if (!component) return null;

	const axes = new Map<string, CvaAxis>();
	for (const [name, axis] of Object.entries(component.axes)) {
		if (PSEUDO_STATE_AXES.has(name)) continue;
		axes.set(name, axis);
	}
	return axes.size > 0 ? axes : null;
}

/**
 * Enum axes only, as a plain `axisName -> values[]` map — the shape the
 * raw-primitive fixer's per-instance className inference consumes. Boolean axes
 * carry no string class value to match against a className, so they're excluded.
 */
export function attributedEnumVariants(
	source: string,
	file: string,
): Record<string, string[]> | null {
	const axes = attributedAxes(source, file);
	if (!axes) return null;

	const result: Record<string, string[]> = {};
	for (const [name, axis] of axes) {
		if (axis.kind === "enum") result[name] = axis.values;
	}
	return Object.keys(result).length > 0 ? result : null;
}
