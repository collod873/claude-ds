import { readFile } from "node:fs/promises";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";

const OPEN_MARKER = "<!-- >>> claude-ds managed >>> -->";
const CLOSE_MARKER = "<!-- <<< claude-ds managed <<< -->";

/**
 * Plan the v0.x → v1.x CLAUDE.md migration: relocate the managed block out of
 * root `CLAUDE.md` into the configured target (`cfg.claude_md_target`, or the
 * decision override `decisions.claudeMdTarget`).
 *
 * Replaces the inline `#34` phase previously embedded in `reconform.ts`. The
 * behavior is preserved verbatim — only the I/O moves through the Runner so
 * dry-run shows the migration as planned Changes instead of `info()` lines.
 *
 * Plan emits:
 *   - one `write` Change to the target (create or append-with-heading), unless
 *     the target already carries an open marker.
 *   - one `delete` or `write` Change for the root `CLAUDE.md`, depending on
 *     whether stripping the managed block leaves user-authored content behind.
 *
 * Idempotent: returns `[]` when there's nothing to do — either target == root,
 * root absent, root has no managed block, or the block is already at the target
 * and root has no managed remnants.
 */
export const migrateClaudeMd: Operation = {
	name: "migrate-claude-md",
	async plan(ctx: ProjectContext): Promise<Change[]> {
		const target = ctx.decisions.claudeMdTarget ?? ctx.cfg.claude_md_target;

		// Target == root: there's no migration to do (the block already lives where
		// it belongs). This guards against running the Op on pre-#34 configs where
		// root IS the configured home.
		if (target === "CLAUDE.md") return [];

		// Source must exist and carry a managed block, else nothing to migrate.
		if (!(await ctx.exists("CLAUDE.md"))) return [];
		const rootContent = await readFile(`${ctx.cwd}/CLAUDE.md`, "utf8");
		const openIdx = rootContent.indexOf(OPEN_MARKER);
		const closeIdx = rootContent.indexOf(CLOSE_MARKER);
		if (openIdx < 0 || closeIdx <= openIdx) return [];

		const inner = rootContent.slice(openIdx + OPEN_MARKER.length, closeIdx).replace(/^\n|\n$/g, "");
		const block = `${OPEN_MARKER}\n${inner}\n${CLOSE_MARKER}\n`;

		const changes: Change[] = [];

		// ── Target write ─────────────────────────────────────────────────────────
		// Three cases:
		//   1. Target absent       → create with `# Project` shell + heading + block.
		//   2. Target present, no open marker → append heading + block (no clobber).
		//   3. Target present, marker already there → skip (idempotent).
		let targetBefore: Buffer | null = null;
		let targetAfter: string | null = null;
		if (await ctx.exists(target)) {
			const tgtCur = await readFile(`${ctx.cwd}/${target}`, "utf8");
			targetBefore = Buffer.from(tgtCur, "utf8");
			if (!tgtCur.includes(OPEN_MARKER)) {
				const sep = tgtCur.endsWith("\n") ? "" : "\n";
				targetAfter = `${tgtCur}${sep}\n## claude-ds\n${block}`;
			}
			// else: target already carries the block, nothing to write.
		} else {
			targetAfter = `# Project\n\n## claude-ds\n${block}`;
		}
		if (targetAfter !== null) {
			changes.push({
				kind: "write",
				path: target,
				before: targetBefore,
				after: Buffer.from(targetAfter, "utf8"),
			});
		}

		// ── Root rewrite-or-delete ───────────────────────────────────────────────
		// Strip the managed block (and an immediately-preceding `## claude-ds`
		// heading the adopt path injects). If the remainder is empty or only the
		// claude-ds-owned `# Project` shell, delete root. Otherwise rewrite it with
		// the user-authored content preserved.
		const before = rootContent.slice(0, openIdx).replace(/\n+$/, "");
		const after = rootContent.slice(closeIdx + CLOSE_MARKER.length).replace(/^\n+/, "");
		const trimmedHeading = before.replace(/##\s+claude-ds\s*$/m, "").replace(/\n+$/, "");
		const stripped = (trimmedHeading + (after ? `\n\n${after}` : "")).trim();
		const isClaudeOwnedShell = stripped === "" || /^#\s+Project\s*$/.test(stripped);

		if (isClaudeOwnedShell) {
			changes.push({
				kind: "delete",
				path: "CLAUDE.md",
				before: Buffer.from(rootContent, "utf8"),
			});
		} else {
			changes.push({
				kind: "write",
				path: "CLAUDE.md",
				before: Buffer.from(rootContent, "utf8"),
				after: Buffer.from(`${stripped}\n`, "utf8"),
			});
		}

		return changes;
	},
};
