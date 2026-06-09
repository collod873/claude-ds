import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { allRuleIds, type DriftRuleId } from "../../../drift/index.js";
import type { Change, Operation } from "../../../operation.js";
import type { ProjectContext } from "../../../project.js";

const EXCEPTIONS_PATH = "design-system/exceptions.json";

const LEGACY_RULE_MAP: Record<string, DriftRuleId> = {
	"DRIFT-AUDIT-TRIGGER": "DRIFT-MISPLACED",
};

interface LegacyEntry {
	rule_id?: string;
	rule?: string;
	file?: string;
	path?: string;
	reason?: string;
	issue?: string;
}

export const migrateExceptions: Operation = {
	name: "migrate-exceptions@v1.0.0",
	async plan(ctx: ProjectContext): Promise<Change[]> {
		if (!(await ctx.exists(EXCEPTIONS_PATH))) return [];

		const abs = join(ctx.cwd, EXCEPTIONS_PATH);
		const raw = await readFile(abs, "utf8");

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return [];
		}

		let entries: LegacyEntry[];
		let wasBareArray = false;
		if (Array.isArray(parsed)) {
			entries = parsed as LegacyEntry[];
			wasBareArray = true;
		} else if (
			parsed &&
			typeof parsed === "object" &&
			Array.isArray((parsed as Record<string, unknown>).exceptions)
		) {
			entries = (parsed as { exceptions: LegacyEntry[] }).exceptions;
		} else {
			return [];
		}

		const validIds = new Set<string>(allRuleIds());
		let needsMigration = wasBareArray;

		for (const e of entries) {
			if (e.rule_id !== undefined || e.file !== undefined) {
				needsMigration = true;
				break;
			}
		}

		if (!needsMigration) return [];

		const migrated: Array<{
			rule: string;
			path: string;
			reason?: string;
			issue?: string;
			permanent?: boolean;
		}> = [];

		for (const e of entries) {
			const ruleRaw = e.rule ?? e.rule_id;
			const pathRaw = e.path ?? e.file;

			if (!ruleRaw || !pathRaw) continue;

			let rule: string;
			if (validIds.has(ruleRaw)) {
				rule = ruleRaw;
			} else if (LEGACY_RULE_MAP[ruleRaw]) {
				rule = LEGACY_RULE_MAP[ruleRaw];
			} else {
				continue;
			}

			const out: {
				rule: string;
				path: string;
				reason?: string;
				issue?: string;
				permanent?: boolean;
			} = { rule, path: pathRaw };
			if (e.issue) {
				out.issue = e.issue;
			} else {
				out.permanent = true;
			}
			out.reason =
				e.reason || (out.permanent ? "Carried forward from pre-v1.0.0 exception" : undefined);
			if (!out.reason) delete out.reason;
			migrated.push(out);
		}

		const after = Buffer.from(JSON.stringify({ exceptions: migrated }, null, 2) + "\n", "utf8");
		const before = Buffer.from(raw, "utf8");

		return [{ kind: "write", path: EXCEPTIONS_PATH, before, after }];
	},
};
