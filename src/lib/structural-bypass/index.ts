import { STRUCTURAL_BYPASSES, STRUCTURAL_BYPASSES_BY_ID } from "./registry.js";
import type { StructuralBypassFinding, StructuralBypassId, StructuralBypassInput } from "./rule.js";

export type {
	StructuralBypass,
	StructuralBypassFinding,
	StructuralBypassId,
	StructuralBypassInput,
} from "./rule.js";
export {
	type ScanStructuralBypassOptions,
	scanStructuralBypass,
} from "./scanner.js";

/**
 * Evaluate all registered structural-bypass signatures against a single
 * file's content. Same shape as `evaluateDrift` / `evaluateOwnedConcerns`:
 * iterate the registry, push every non-null finding. Pure over its input.
 */
export function evaluateStructuralBypass(input: StructuralBypassInput): StructuralBypassFinding[] {
	const findings: StructuralBypassFinding[] = [];
	for (const bypass of STRUCTURAL_BYPASSES) {
		const finding = bypass.detect(input);
		if (finding) findings.push(finding);
	}
	return findings;
}

/** All registered structural-bypass ids, in canonical registry order. */
export function allStructuralBypassIds(): StructuralBypassId[] {
	return STRUCTURAL_BYPASSES.map((b) => b.id);
}

/** Human-readable description for a structural-bypass id. */
export function structuralBypassDescription(id: StructuralBypassId): string {
	return STRUCTURAL_BYPASSES_BY_ID[id].description;
}

/**
 * Render a structural-bypass finding as a single markdown bullet for the
 * audit's advisory section.
 *
 * The wording is deliberately non-imperative — these are *triage candidates*,
 * not gate failures. It names the bypassed atom and the dismissal path so a
 * legitimate look-alike (a non-badge `rounded-full` pill) reads as
 * "review and dismiss," never "you must change this."
 */
export function formatStructuralBypassFinding(finding: StructuralBypassFinding): string {
	return (
		`- \`${finding.file}:${finding.line}\` (${finding.bypassId}): ${finding.message} ` +
		`— review: import the ${finding.atom} atom, or dismiss via design-system/exceptions.json ` +
		`(\`${finding.bypassId}\`:\`${finding.file}\`) if this is a legitimate non-atom use`
	);
}
