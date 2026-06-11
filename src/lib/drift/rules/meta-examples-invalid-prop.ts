import { readFile } from "node:fs/promises";
import { join } from "node:path";

import * as ts from "typescript";

import {
	analyzeCvaComponents,
	type CvaAxis,
	collectExportedComponentNames,
	collectFileCvaAxes,
} from "../../cva/analyzer.js";
import type { Change } from "../../operation.js";
import type { ProjectContext } from "../../project.js";
import { primaryComponent, primaryComponentNames } from "../cva.js";
import type { DriftFinding, DriftRule, DriftRuleInput, FixResult } from "../rule.js";

/**
 * DRIFT-META-EXAMPLES-INVALID-PROP — poisoned-example repair (PRD #546).
 *
 * Validates the props of existing `meta.examples` entries against the
 * component's actual variant surface, per the per-component CVA attribution
 * analyzer (#552). Two defects are caught, both residue of older buggy fixers:
 *
 *   - a **leaked sub-element axis**: a prop named after a cva axis defined in
 *     the file but NOT attributed to the showcased component (the multi-CVA
 *     sub-element leak — `<Combobox size="sm">` where `size` belongs to an
 *     internal trigger, not the root the showcase renders).
 *   - an **out-of-range variant value**: a prop keyed to a real axis of the
 *     showcased component but carrying a value outside that axis's declared
 *     set (the Crewops `tone: "dark"` — the leaked Tailwind `dark:` modifier).
 *
 * A prop that matches NO cva axis in the file is left alone: it is
 * indistinguishable from a legitimate hand-authored prop (Crewops Radio's
 * required `value`), and claude-ds's example writers only ever wrote
 * axis-shaped props — so non-axis keys are not residue.
 *
 * This is fixable-managed territory, never hand-verify: claude-ds authored
 * these examples, so the repair (drop the offending prop, or the whole example
 * when its props go empty) is the tool fixing its own past output before it
 * regenerates a broken showcase on the next heal.
 *
 * The valid surface is the PRIMARY component's attribution (the component the
 * showcase renders examples on — see `primaryComponent`), never the union of
 * every exported component's axes. The rule stays silent on files that define
 * no cva axes at all: with no axis surface anywhere, it never second-guesses a
 * hand-authored non-CVA example.
 */

/**
 * Props every React/DOM component accepts — never a variant axis, never
 * offending. Kept deliberately broad: the failure mode to avoid is dropping a
 * legitimate prop, so anything plausibly-universal is reserved.
 */
const RESERVED_PROPS = new Set([
	"children",
	"className",
	"class",
	"style",
	"id",
	"key",
	"ref",
	"slot",
	"title",
	"role",
	"tabIndex",
	"hidden",
	"dir",
	"lang",
	"name",
]);

function isReservedProp(key: string): boolean {
	return (
		RESERVED_PROPS.has(key) ||
		key.startsWith("data-") ||
		key.startsWith("aria-") ||
		/^on[A-Z]/.test(key)
	);
}

/**
 * The two surfaces validation needs.
 *
 * `primaryAxes` is the valid-prop surface: the axes of the PRIMARY component
 * only — the one the showcase renders every example on. Never the union of all
 * exported components: a trigger sub-component's `size` is a real axis on the
 * trigger, but an example `{ size: "sm" }` still renders as `<Combobox size>`,
 * a prop the root rejects (the Crewops v1.8.1 break). It may be empty (a
 * multi-part atom whose cva lives on a sub-part).
 *
 * `fileAxisNames` is the residue-recognition surface: every axis any cva in
 * the file declares. Only props on THIS surface (but off the primary one) are
 * repairable residue; anything else is presumed a real component prop.
 */
function surfaces(
	source: string,
	file: string,
): { primaryAxes: Map<string, CvaAxis>; fileAxisNames: Set<string> } | null {
	const fileAxisNames = new Set(Object.keys(collectFileCvaAxes(ts, source, file)));
	if (fileAxisNames.size === 0) return null;
	const attribution = analyzeCvaComponents(ts, source, file);
	const primary = primaryComponent(attribution, file);
	if (primary) return { primaryAxes: new Map(Object.entries(primary.axes)), fileAxisNames };
	// Unattributed primary: either the render target exists but consumes no cva
	// (Crewops Combobox root — validate; axis-named props on it ARE residue), or
	// no export matches the filename's PascalCase at all (QRCode in qr-code.tsx —
	// the render target is unknown, and condemning every axis-named prop against
	// an empty surface would delete valid user content; stay silent).
	const exported = collectExportedComponentNames(ts, source, file);
	if (!primaryComponentNames(file).some((n) => exported.has(n))) return null;
	return { primaryAxes: new Map(), fileAxisNames };
}

interface PropLiteral {
	type: "string" | "bool" | "number";
	text: string;
}

function valueLiteral(node: ts.Expression): PropLiteral | null {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		return { type: "string", text: node.text };
	}
	if (node.kind === ts.SyntaxKind.TrueKeyword) return { type: "bool", text: "true" };
	if (node.kind === ts.SyntaxKind.FalseKeyword) return { type: "bool", text: "false" };
	if (ts.isNumericLiteral(node)) return { type: "number", text: node.text };
	return null;
}

/**
 * Classify one example prop against the variant surface. Returns the offense
 * detail string when the prop is poison, or `null` when it is acceptable.
 * Conservative by construction: anything not a concrete literal, and anything
 * reserved, is left alone.
 */
function classifyProp(
	key: string,
	valueNode: ts.Expression | undefined,
	axes: Map<string, CvaAxis>,
	fileAxisNames: ReadonlySet<string>,
): string | null {
	if (isReservedProp(key)) return null;
	const axis = axes.get(key);
	if (!axis) {
		// Axis-shaped but not the showcased component's: claude-ds residue.
		// Not an axis anywhere: plausibly a real prop — never touch it.
		return fileAxisNames.has(key) ? `leaked sub-element axis "${key}"` : null;
	}

	const lit = valueNode ? valueLiteral(valueNode) : null;
	if (!lit) return null; // boolean `{true}`, shorthand, or non-literal — leave alone

	if (axis.kind === "boolean") {
		if (lit.type === "bool") return null;
		// The string forms "true"/"false" are the boolean-as-string concern owned
		// by the example writers, not this rule — don't drop them here.
		if (lit.type === "string" && (lit.text === "true" || lit.text === "false")) return null;
		return `${key}=${JSON.stringify(lit.text)} (not a boolean)`;
	}

	if (lit.type === "string" && axis.values.includes(lit.text)) return null;
	return `${key}=${JSON.stringify(lit.text)} (not a "${key}" value)`;
}

interface Offense {
	detail: string;
}

interface RepairPlan {
	offenses: Offense[];
	/** Offending property-assignment nodes to splice out of their props object. */
	propDeletes: ts.Node[];
	/** Example entries whose props go empty — splice the whole entry. */
	entryDeletes: ts.Node[];
}

/** Locate the first `examples: [ … ]` array-literal in the file. */
function findExamplesArray(sf: ts.SourceFile): ts.ArrayLiteralExpression | null {
	let found: ts.ArrayLiteralExpression | null = null;
	const visit = (node: ts.Node): void => {
		if (found) return;
		if (
			ts.isPropertyAssignment(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === "examples" &&
			ts.isArrayLiteralExpression(node.initializer)
		) {
			found = node.initializer;
			return;
		}
		node.forEachChild(visit);
	};
	visit(sf);
	return found;
}

function propKeyName(name: ts.PropertyName): string | null {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}
	return null;
}

/** The `name:` string-literal of an example entry, for offense messages. */
function exampleName(entry: ts.ObjectLiteralExpression): string | null {
	for (const p of entry.properties) {
		if (
			ts.isPropertyAssignment(p) &&
			ts.isIdentifier(p.name) &&
			p.name.text === "name" &&
			ts.isStringLiteral(p.initializer)
		) {
			return p.initializer.text;
		}
	}
	return null;
}

/**
 * Walk every example's `props` object, classify each settable prop, and build
 * the repair plan. Pure over `(source, axes)`; shared by `detect` and `fix`.
 */
function planRepair(
	source: string,
	axes: Map<string, CvaAxis>,
	fileAxisNames: ReadonlySet<string>,
): RepairPlan {
	const plan: RepairPlan = { offenses: [], propDeletes: [], entryDeletes: [] };

	const sf = ts.createSourceFile(
		"examples.tsx",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);
	const examples = findExamplesArray(sf);
	if (!examples) return plan;

	for (const element of examples.elements) {
		if (!ts.isObjectLiteralExpression(element)) continue;

		const propsProp = element.properties.find(
			(p): p is ts.PropertyAssignment =>
				ts.isPropertyAssignment(p) &&
				ts.isIdentifier(p.name) &&
				p.name.text === "props" &&
				ts.isObjectLiteralExpression(p.initializer),
		);
		if (!propsProp || !ts.isObjectLiteralExpression(propsProp.initializer)) continue;

		const label = exampleName(element);
		const offendingNodes: ts.Node[] = [];
		let settable = 0;
		let hasOther = false; // spread / computed — never drop the whole entry

		for (const p of propsProp.initializer.properties) {
			let key: string | null = null;
			let valueNode: ts.Expression | undefined;
			if (ts.isPropertyAssignment(p)) {
				key = propKeyName(p.name);
				valueNode = p.initializer;
			} else if (ts.isShorthandPropertyAssignment(p)) {
				key = p.name.text;
			} else {
				hasOther = true;
				continue;
			}
			if (key === null) {
				hasOther = true;
				continue;
			}
			settable++;
			const detail = classifyProp(key, valueNode, axes, fileAxisNames);
			if (detail !== null) {
				offendingNodes.push(p);
				plan.offenses.push({ detail: label ? `"${label}" ${detail}` : detail });
			}
		}

		if (offendingNodes.length === 0) continue;

		if (!hasOther && offendingNodes.length === settable) {
			plan.entryDeletes.push(element);
		} else {
			plan.propDeletes.push(...offendingNodes);
		}
	}

	return plan;
}

/**
 * Compute the splice range that removes a comma-separated list node (an example
 * entry or a props property) cleanly: the node, its leading whitespace, and one
 * adjacent comma (trailing if present, else the preceding one).
 */
function listNodeRange(source: string, node: ts.Node): [number, number] {
	const start = node.getFullStart();
	const end = node.getEnd();

	let j = end;
	while (j < source.length && /\s/.test(source[j])) j++;
	if (source[j] === ",") {
		return [start, j + 1];
	}

	// No trailing comma — consume the preceding one so no dangling separator
	// is left behind.
	let k = start - 1;
	while (k >= 0 && (source[k] === " " || source[k] === "\t")) k--;
	if (source[k] === ",") return [k, end];
	return [start, end];
}

function applyDeletes(source: string, nodes: ts.Node[]): string {
	// Two adjacent offenders share one separator: the earlier's trailing comma is
	// the later's preceding comma, so their ranges overlap. Merge overlapping
	// ranges (rather than dropping one whole) so every offender is removed — a
	// skip would leave the earlier offender behind. An entry range that contains
	// a prop range (claimed impossible upstream) likewise merges to the entry.
	const ranges = nodes.map((n) => listNodeRange(source, n)).sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const [start, end] of ranges) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1]) {
			last[1] = Math.max(last[1], end);
		} else {
			merged.push([start, end]);
		}
	}
	let result = source;
	for (let i = merged.length - 1; i >= 0; i--) {
		const [start, end] = merged[i];
		result = result.slice(0, start) + result.slice(end);
	}
	return result;
}

function detect(input: DriftRuleInput): DriftFinding | null {
	const { file, locationTier, source } = input;
	if (locationTier === null) return null;
	if (source === undefined) return null;
	if (!source.includes("cva(")) return null;

	const s = surfaces(source, file);
	if (!s) return null;
	const plan = planRepair(source, s.primaryAxes, s.fileAxisNames);
	if (plan.offenses.length === 0) return null;

	const n = plan.offenses.length;
	return {
		ruleId: "DRIFT-META-EXAMPLES-INVALID-PROP",
		file,
		message: `${n} invalid meta.examples prop${n === 1 ? "" : "s"}: ${plan.offenses
			.map((o) => o.detail)
			.join(", ")}`,
	};
}

async function fix(finding: DriftFinding, ctx: ProjectContext): Promise<FixResult> {
	const absPath = join(ctx.cwd, finding.file);
	let source: string;
	try {
		source = await readFile(absPath, "utf8");
	} catch {
		return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
	}

	const s = surfaces(source, finding.file);
	const plan = s ? planRepair(source, s.primaryAxes, s.fileAxisNames) : null;
	if (!plan || plan.offenses.length === 0) {
		return {
			finding,
			fixed: false,
			message: `no invalid meta.examples props found in ${finding.file}`,
			changes: [],
		};
	}

	// Whole-entry deletes and prop deletes never overlap (an entry is only
	// dropped when ALL its props are offending, in which case those props are
	// not also queued as prop deletes), but `applyDeletes` guards regardless.
	const result = applyDeletes(source, [...plan.entryDeletes, ...plan.propDeletes]);

	if (result === source) {
		return {
			finding,
			fixed: false,
			message: `could not repair meta.examples in ${finding.file}`,
			changes: [],
		};
	}

	const droppedProps = plan.propDeletes.length;
	const droppedEntries = plan.entryDeletes.length;
	const parts: string[] = [];
	if (droppedProps > 0) parts.push(`${droppedProps} invalid prop${droppedProps === 1 ? "" : "s"}`);
	if (droppedEntries > 0)
		parts.push(`${droppedEntries} emptied example${droppedEntries === 1 ? "" : "s"}`);

	const changes: Change[] = [
		{
			kind: "write",
			path: finding.file,
			before: Buffer.from(source),
			after: Buffer.from(result),
		},
	];

	return {
		finding,
		fixed: true,
		message: `dropped ${parts.join(" and ")} from meta.examples in ${finding.file}`,
		changes,
	};
}

export const metaExamplesInvalidPropRule: DriftRule = {
	id: "DRIFT-META-EXAMPLES-INVALID-PROP",
	severity: "error",
	description:
		"meta.examples carries a prop the component never accepts, or a variant value outside the axis's declared values",
	detect,
	fixable: true,
	fix,
	priority: 3,
	interactive: false,
};
