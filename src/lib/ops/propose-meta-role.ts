import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Change, Operation } from "../operation.js";
import type { ProjectContext } from "../project.js";
import { proposeRole } from "../role-proposer.js";
import { metaRoleFromSource } from "../three-signal.js";

/** Dirs scanned for `.tsx` smart parts that might need a `meta.role` proposal. */
const SCAN_DIRS = ["design-system/atoms", "design-system/composites"];

const COMPANION_SUFFIXES = [".showcase.tsx", ".test.tsx", ".stories.tsx"];
const SKIP_PATTERNS = [/^index\.ts$/, /\.logic\.ts$/, /\.d\.ts$/];

/**
 * Matches the `kind: "atom"` / `kind: "composite"` field inside a meta literal
 * — the anchor we append `role: "<name>"` after. Scoped to `meta = { … }` so
 * an unrelated object literal carrying a `kind` field never matches. `[\s\S]`
 * spans the inevitable newlines between `meta = {` and the kind field; `?`
 * after `[\s\S]*` keeps the match lazy so a later sibling property doesn't
 * absorb the kind line.
 */
const META_KIND_LITERAL_RE =
	/(\bmeta\b[^=]*=[^{]*\{[\s\S]*?\bkind\s*:\s*["'](?:atom|composite)["'])/;

export interface MetaRoleProposal {
	file: string;
	proposal:
		| { kind: "role"; role: string; written: boolean }
		| { kind: "candidate-feature" }
		| { kind: "tracked-exception" };
}

export interface ProposeMetaRoleOutcome {
	proposals: MetaRoleProposal[];
}

/**
 * Walk `design-system/atoms/` and `design-system/composites/`, propose a
 * `meta.role` for each smart part that doesn't declare one (PRD #301 / #312).
 *
 * The proposer (`src/lib/role-proposer.ts`) is the classifier; this Op is the
 * "turn the proposal into bytes" layer. Two paths:
 *
 *   - `{ kind: "role" }` — inject `, role: "<name>"` after the `kind`
 *     field. The contract runner can then drive the component on the next
 *     test pass. Written through the Runner like any other byte change.
 *   - `{ kind: "candidate-feature" }` — no bytes written. The outcome row
 *     surfaces the file so `classify` can print the ADR-0005 hand-off
 *     (presentational / features/ / tracked exception). Audit's
 *     `DRIFT-SMART-PART-NO-ROLE` keeps the gap visible once
 *     `role_contracts_strict` flips on.
 *
 * Files already carrying a `meta.role` are skipped — `classify proposes; it
 * does not silently rewrite without the existing decision flow` (#312). A
 * proposal landing on a file whose meta block can't be located (malformed
 * source) also yields no write; we surface the proposal so the consumer can
 * fix the source and re-run.
 */
export function proposeMetaRole(): Operation<ProposeMetaRoleOutcome> {
	return {
		name: "classify-propose-meta-role",
		async plan(ctx: ProjectContext) {
			const changes: Change[] = [];
			const proposals: MetaRoleProposal[] = [];

			for (const scanRel of SCAN_DIRS) {
				const scanAbs = join(ctx.cwd, scanRel);
				if (!(await ctx.exists(scanRel))) continue;

				let entries: string[];
				try {
					entries = await readdir(scanAbs);
				} catch {
					continue;
				}

				for (const entry of entries) {
					if (!entry.endsWith(".tsx")) continue;
					if (COMPANION_SUFFIXES.some((s) => entry.endsWith(s))) continue;
					if (SKIP_PATTERNS.some((re) => re.test(entry))) continue;

					const entryAbs = join(scanAbs, entry);
					const s = await stat(entryAbs).catch(() => null);
					if (!s || !s.isFile()) continue;

					const source = await readFile(entryAbs, "utf8").catch(() => null);
					if (source === null) continue;

					// Already-declared roles are the consumer's intent. Skip — no
					// proposal, no rewrite. The shipped contract runs against them
					// regardless; audit's `DRIFT-ROLE-NO-CONTRACT` is the surface for
					// a declared role that lacks a contract.
					if (metaRoleFromSource(source) !== null) continue;

					const proposal = proposeRole(source, ctx.auditConfig.domainRoots);
					if (proposal === null) continue;

					const relPath = join(scanRel, entry);
					if (proposal.kind === "candidate-feature") {
						proposals.push({ file: relPath, proposal: { kind: "candidate-feature" } });
						continue;
					}
					if (proposal.kind === "tracked-exception") {
						proposals.push({ file: relPath, proposal: { kind: "tracked-exception" } });
						continue;
					}

					const after = injectRoleAfterKind(source, proposal.role);
					if (after === null) {
						// Meta block didn't match the kind-field anchor — surface the
						// proposal without a write so the user can hand-edit. Audit will
						// keep flagging the missing role on subsequent runs.
						proposals.push({
							file: relPath,
							proposal: { kind: "role", role: proposal.role, written: false },
						});
						continue;
					}

					changes.push({
						kind: "write",
						path: relPath,
						before: Buffer.from(source, "utf8"),
						after: Buffer.from(after, "utf8"),
					});
					proposals.push({
						file: relPath,
						proposal: { kind: "role", role: proposal.role, written: true },
					});
				}
			}

			return { changes, outcome: { proposals } };
		},
	};
}

/**
 * Insert `, role: "<role>"` after the `kind` field of the file's meta
 * literal. Returns `null` when the meta block can't be located by the kind
 * anchor — the caller surfaces that as an un-written proposal.
 */
function injectRoleAfterKind(source: string, role: string): string | null {
	if (!META_KIND_LITERAL_RE.test(source)) return null;
	return source.replace(META_KIND_LITERAL_RE, `$1, role: "${role}"`);
}
