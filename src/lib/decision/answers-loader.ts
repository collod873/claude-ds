import { readFile } from "node:fs/promises";
import type { AnswerBag, DecisionAnswer } from "./types.js";

/**
 * Load the `--answers <file>` JSON bag. Validates the shape so a malformed
 * answers file fails before the resolver runs — the alternative is silently
 * dropping an entry that was meant to resolve a genuine Ambiguity, which
 * would re-introduce the silent-project-decisions failure ADR-0023 closes.
 *
 * Allowed value shape per id:
 *   - `number` — index into `Decision.options`
 *   - `"defer"` — explicit skip / no-op (recorded in `exceptions.json` by the
 *      command consuming the bag)
 *
 * Anything else throws with the offending id named so the operator can fix
 * the file and re-run.
 */
export async function loadAnswersFile(path: string): Promise<AnswerBag> {
	const raw = await readFile(path, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`--answers ${path}: invalid JSON — ${msg}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`--answers ${path}: top-level must be a JSON object keyed by Decision id`);
	}
	const bag: AnswerBag = {};
	for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
			bag[id] = value as DecisionAnswer;
		} else if (value === "defer") {
			bag[id] = "defer";
		} else {
			throw new Error(
				`--answers ${path}: entry "${id}" must be a non-negative integer or "defer" (got ${JSON.stringify(value)})`,
			);
		}
	}
	return bag;
}
