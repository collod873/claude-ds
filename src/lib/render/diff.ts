import type { Change } from "../operation.js";
import { renderDiff } from "../runner.js";
import type { ColorAdapter } from "./color.js";

/**
 * One entry in a commitment-gate preview: the Op that produced the Change
 * (so the consumer can trace authorship) plus the Change itself. The shape
 * mirrors the planned-Change tuples the Runner already iterates in dry-run.
 */
export interface DiffEntry {
	opName: string;
	change: Change;
}

/**
 * Render a commitment-gate preview to a flat line array. Pure — delegates to
 * the Runner's `renderDiff` so the bytes match what `dry-run` would print,
 * then splits multi-line entries so the printer (or `colorizeDiffLines`) can
 * paint each line independently.
 *
 * This is the diff slice 1's resolver hands a commitment-gate Decision: the
 * TTY layer paints it via `colorizeDiffLines`; snapshot tests assert the pure
 * lines verbatim.
 */
export function renderCommitmentGateDiff(entries: DiffEntry[]): string[] {
	const lines: string[] = [];
	for (const { opName, change } of entries) {
		for (const line of renderDiff(opName, change).split("\n")) {
			lines.push(line);
		}
	}
	return lines;
}

/**
 * Apply color via an injected `ColorAdapter` to a flat diff line array. The
 * adapter is the seam that keeps `picocolors` out of the non-TTY path — pass
 * `identityColor` and the bytes are unchanged.
 *
 *   `+...`  → green   (added)
 *   `-...`  → red     (removed)
 *   `[...]` → dim     (op-name header / abort / binary-content note)
 *   else    → unchanged
 */
export function colorizeDiffLines(lines: string[], color: ColorAdapter): string[] {
	return lines.map((line) => {
		if (line.startsWith("+")) return color.green(line);
		if (line.startsWith("-")) return color.red(line);
		if (line.startsWith("[")) return color.dim(line);
		return line;
	});
}
