import type { StructuralBypass, StructuralBypassFinding, StructuralBypassInput } from "../rule.js";

/**
 * BYPASS-TOAST — a direct `sonner` import in consumer component code.
 *
 * The motivating Crewops hand-roll (issue #457): app code reaching past the
 * DS toast wrapper straight to the underlying library —
 *
 *   import { toast } from 'sonner';
 *
 * Signature: any ES import whose module specifier is exactly `sonner`. The
 * DS toast wrapper itself imports `sonner` (that is its whole job), but it
 * lives under `design-system/`, which the scanner excludes — so the wrapper
 * never self-flags and only the bypassing app-code import is caught.
 *
 * Unlike the Card/Badge signatures this keys on the import, not a className,
 * so it has no `class-names` dependency.
 *
 * Pure: reads source + path only. No FS, no consumer coupling.
 */

const SONNER_IMPORT = /\bfrom\s+['"]sonner['"]/;

function detect(input: StructuralBypassInput): StructuralBypassFinding | null {
	const { file, source } = input;
	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (SONNER_IMPORT.test(lines[i])) {
			return {
				bypassId: "BYPASS-TOAST",
				file,
				line: i + 1,
				atom: "toast",
				message: `direct 'sonner' import — use the DS toast wrapper instead`,
			};
		}
	}
	return null;
}

export const toastBypassRule: StructuralBypass = {
	id: "BYPASS-TOAST",
	atom: "toast",
	description: "Consumer imported `sonner` directly instead of the DS toast wrapper",
	detect,
};
