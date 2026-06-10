import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The consumer-editable `design-system/enforcement.json` (#465). Mirrors the
 * shape the shell reader `.claude/hooks/lib/read-enforcement.sh` parses, so
 * TS code (the Owned-concern scanner's hook-liveness gate, #505) and the hooks
 * agree on what "live" means. Seeded once on adopt, freely edited thereafter.
 */
export interface EnforcementConfig {
	componentLib: "radix" | "base-ui";
	tokenScope: "design-system" | "app-wide";
}

export const ENFORCEMENT_PATH = "design-system/enforcement.json";

/** The pack defaults — every opt-in gate inert (`never break a consumer`). */
export const ENFORCEMENT_DEFAULTS: EnforcementConfig = {
	componentLib: "radix",
	tokenScope: "design-system",
};

/**
 * Read `design-system/enforcement.json` under `cwd`, falling back to the
 * inert defaults when the file is absent or unparseable — same forgiving
 * posture as the shell reader. Reads only the two enforcement flags;
 * `appWideExclude` is the hooks' concern, not this reader's.
 */
export async function readEnforcement(cwd: string): Promise<EnforcementConfig> {
	let raw: string;
	try {
		raw = await readFile(join(cwd, ENFORCEMENT_PATH), "utf8");
	} catch {
		return { ...ENFORCEMENT_DEFAULTS };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ...ENFORCEMENT_DEFAULTS };
	}
	const obj = (parsed ?? {}) as Record<string, unknown>;
	const componentLib = obj.componentLib === "base-ui" ? "base-ui" : "radix";
	const tokenScope = obj.tokenScope === "app-wide" ? "app-wide" : "design-system";
	return { componentLib, tokenScope };
}
