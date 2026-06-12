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
