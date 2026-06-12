import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectContext } from "../project.js";

/** Read a file and return its contents, or null if absent/unreadable. */
async function readOrNull(p: string): Promise<string | null> {
	try {
		return await readFile(p, "utf8");
	} catch {
		return null;
	}
}

/**
 * Reconform-time stub-file hint for the two seeded files consumers must
 * consolidate by hand (contracts.md, tokens.json). #366: switched from a
 * line-count heuristic that fired every run with no acknowledge path to an
 * untouched-vs-seeded check — the hint fires only while the file is the
 * verbatim pack seed (or absent). The moment the operator edits the file,
 * even by one byte, the hint goes silent — that *is* the acknowledge path,
 * no flag or config field required.
 *
 * Framed as a "→ Customize:" hint (not a "WARNING") because the line above
 * this in reconform's output is "check pass: no violations found" — a stub the
 * operator hasn't gotten to yet is not a check failure. #454: NOT a "→ Next:"
 * line — this is by-hand editing guidance, not a runnable command, and the
 * next-step-liveness gate (ADR-0013) rightly grades a `Next:` that can't be run
 * as a dead end. A distinct prefix keeps the guidance without that promise.
 */
export async function emitStubHint(ctx: ProjectContext): Promise<void> {
	const { cwd, packDir } = ctx;
	const targets = [
		{
			rel: "design-system/contracts.md",
			recipe:
				"describe your DS's per-component bundle, import rules, and review cadence (see the seed for the canonical structure)",
		},
		{
			rel: "design-system/tokens.json",
			recipe:
				"add the colors / spacing / motion / shadow / z-index scales your app actually uses (extend or replace the seed entries)",
		},
	];

	const untouched: { rel: string; recipe: string; reason: "absent" | "verbatim-seed" }[] = [];
	for (const t of targets) {
		const seed = await readOrNull(join(packDir, "files", t.rel));
		if (seed === null) continue;
		const current = await readOrNull(join(cwd, t.rel));
		if (current === null) {
			untouched.push({ ...t, reason: "absent" });
		} else if (current === seed) {
			untouched.push({ ...t, reason: "verbatim-seed" });
		}
	}
	if (untouched.length === 0) return;

	const lines: string[] = [
		"",
		"→ Customize: consolidate these seeded files (still the pack defaults — edit to silence):",
	];
	for (const u of untouched) {
		const tag = u.reason === "absent" ? "missing" : "untouched seed";
		lines.push(`  ${u.rel} (${tag}) — ${u.recipe}`);
	}
	lines.push("");
	process.stdout.write(`${lines.join("\n")}\n`);
}
