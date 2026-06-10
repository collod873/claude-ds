import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { SCAN_SKIP_DIRS } from "./build-outputs.js";
import type { EnforcementConfig } from "./enforcement.js";
import { ENFORCEMENT_DEFAULTS } from "./enforcement.js";
import { isManifestOrKeepfile } from "./manifest.js";
import { evaluateOwnedConcerns } from "./owned-concerns/index.js";

/**
 * Detect the enforcement flags a consumer's tree actually warrants (#505).
 *
 * `design-system/enforcement.json` is a `seeded` file. Seeding it with the
 * pack defaults (`componentLib: radix`, `tokenScope: design-system`) silently
 * neuters the v1.7.0 opt-in hooks on a consumer who is base-ui / app-wide —
 * the new gates exit early and do nothing, while the consumer's hand-rolled
 * validators carry on as dead-weight duplicates. So before writing a fresh
 * enforcement.json, derive the flags from the tree:
 *
 *   - `componentLib: "base-ui"` when the consumer imports a base-ui package,
 *     or already hand-rolled a base-ui asChild validator (the very infra the
 *     base-ui hook absorbs).
 *   - `tokenScope: "app-wide"` when the consumer already hand-rolled an
 *     app-wide token validator — direct evidence they enforce tokens app-wide.
 *     This is the safe signal: the pack hook only takes over what the consumer
 *     was already blocking, so it never newly blocks a file ("never break a
 *     consumer"). Absent that evidence the default (DS-scoped) stands.
 *
 * The hand-rolled-validator signals reuse the Owned-concern detectors so
 * "what a hand-rolled X looks like" has one definition (the same files
 * `doctor --completeness` flags for retirement). Deterministic over the tree:
 * same tree → same result, so callers in `plan()` stay pure.
 *
 * Pack-managed paths are excluded before detection (`manifestPaths`), exactly
 * as the Owned-concern scanner does — the pack's own `pre-write-base-ui.sh`
 * and `pre-write-tokens-app-wide.sh` match the validator detectors by content,
 * so failing to exclude them would let the pack's own hooks flip a Radix /
 * DS-scoped consumer to base-ui / app-wide, activating the opt-in gates and
 * blocking legitimate code ("never break a consumer").
 */

const SCANNABLE_EXTS: ReadonlySet<string> = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".sh",
	".bash",
]);

/** base-ui package imports — `@base-ui-components/react`, `@base-ui/*`, etc. */
const BASE_UI_IMPORT_RE =
	/(?:from|import|require)\s*\(?\s*['"]@base-ui[\w./-]*['"]|['"]@base-ui-components\/[\w./-]+['"]/;

async function walkRepo(cwd: string): Promise<string[]> {
	const results: string[] = [];
	async function walk(rel: string): Promise<void> {
		const abs = rel ? join(cwd, rel) : cwd;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(abs, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory()) {
				if (SCAN_SKIP_DIRS.has(e.name)) continue;
				await walk(rel ? `${rel}/${e.name}` : e.name);
				continue;
			}
			if (!e.isFile()) continue;
			results.push(rel ? `${rel}/${e.name}` : e.name);
		}
	}
	await walk("");
	return results;
}

export async function detectEnforcement(
	cwd: string,
	manifestPaths: Set<string> = new Set(),
): Promise<EnforcementConfig> {
	let componentLib: EnforcementConfig["componentLib"] = ENFORCEMENT_DEFAULTS.componentLib;
	let tokenScope: EnforcementConfig["tokenScope"] = ENFORCEMENT_DEFAULTS.tokenScope;

	const files = await walkRepo(cwd);
	for (const file of files) {
		// Pack-managed files match the validator detectors by content (the pack's
		// own hooks absorb those validators) — exclude them so the pack never
		// detects its own infra as the consumer's (#505).
		if (isManifestOrKeepfile(file, manifestPaths)) continue;
		if (!SCANNABLE_EXTS.has(extname(file))) continue;
		let source: string;
		try {
			source = await readFile(join(cwd, file), "utf8");
		} catch {
			continue;
		}

		if (componentLib !== "base-ui" && BASE_UI_IMPORT_RE.test(source)) {
			componentLib = "base-ui";
		}

		// Reuse the Owned-concern detectors as the single source of truth for
		// "what a hand-rolled validator looks like".
		if (componentLib !== "base-ui" || tokenScope !== "app-wide") {
			const findings = evaluateOwnedConcerns({ file, source });
			for (const f of findings) {
				if (f.concernId === "OWNED-BASE-UI-ASCHILD-VALIDATOR") componentLib = "base-ui";
				if (f.concernId === "OWNED-APP-WIDE-TOKEN-LINT") tokenScope = "app-wide";
			}
		}

		if (componentLib === "base-ui" && tokenScope === "app-wide") break;
	}

	return { componentLib, tokenScope };
}

/**
 * Apply detected flags onto the pack's seed bytes, preserving everything else
 * (`$schema-note`, `appWideExclude`) and the seed's 2-space + trailing-newline
 * format. Returns `seed` unchanged if it does not parse (defensive — the pack
 * ships valid JSON).
 */
export function applyDetectedEnforcement(seed: string, detected: EnforcementConfig): string {
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(seed) as Record<string, unknown>;
	} catch {
		return seed;
	}
	obj.componentLib = detected.componentLib;
	obj.tokenScope = detected.tokenScope;
	return `${JSON.stringify(obj, null, 2)}\n`;
}
