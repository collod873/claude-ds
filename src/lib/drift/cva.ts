import { basename } from "node:path";

import * as ts from "typescript";

import {
	analyzeCvaComponents,
	type ComponentCva,
	type CvaAttribution,
	type CvaAxis,
} from "../cva/analyzer.js";

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
 * The component a file's `meta.examples` (and showcase) render on: the export
 * whose name is the PascalCase of the file's basename, matching the showcase
 * generator's own selection (`attribution[displayName] ?? attribution[componentName]`).
 *
 * Scoping to the render target — never the union of all exported components —
 * is what keeps the fixers and the generator agreeing. A trigger sub-component
 * may legitimately expose `size`; writing a `size` example into the ROOT's meta
 * would still emit `<Combobox size="sm">`, a prop the root rejects (the Crewops
 * v1.8.1 break).
 */
export function primaryComponent(attribution: CvaAttribution, file: string): ComponentCva | null {
	for (const name of primaryComponentNames(file)) {
		const hit = attribution[name];
		if (hit) return hit;
	}
	return null;
}

/**
 * The candidate export names the showcase generator resolves a file's render
 * target against, in its lookup order (PascalCase displayName, raw basename).
 */
export function primaryComponentNames(file: string): string[] {
	const base = basename(file).replace(/\.[^.]+$/, "");
	return [toPascalCase(base), base];
}

/** Mirrors the showcase generator's display-name derivation. */
function toPascalCase(name: string): string {
	return name
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join("");
}

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
