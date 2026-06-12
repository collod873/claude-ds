/**
 * The dashboard renderer (PRD #325 sub-issue #330). Pure: it takes a
 * resolved `DashboardState` plus the TTY-gated `ColorAdapter` and returns a
 * `string[]`. The front door fills the state in (composing `doctor` structural
 * state + a read-only `audit` run) and passes `loadColorAdapter()`; this module
 * pins the renderer contract and the representative-fixture outputs.
 *
 * The shape is now two sections — "where you are / what's wrong". The third,
 * "recommended next step", was the flat single-shot `recommendedNext`
 * recommender, retired in #345 (ADR-0018): the front door no longer hands the
 * user a `→ Next: <type this>` breadcrumb. It drives the shared remediation
 * planner directly, presenting one commitment gate (rendered from the real
 * planned `Change[]`) and auto-advancing to clean. "What to do next" is the
 * gate, not a recommended string.
 *
 * #620 (PRD #618): every rendered string is plain consumer language. Internal
 * vocabulary — drift, hand-rolled DS infra, owned-concern scan, scaffold, the
 * `pre-adopt`/`adopted` mode names — stays in this file's types and the docs
 * but NEVER prints. Status markers are limited to ✓ (good), ! (action the tool
 * can take), and ✗ (a problem the tool can't resolve for you); the words around
 * each marker carry the meaning. The renderer takes the color adapter as input
 * so the markers/path are colored on a TTY and plain (identity) when piped or
 * under test.
 */

import type { HandRolledSplit } from "../hand-rolled-split.js";
import type { ColorAdapter } from "./color.js";
import { CHECK } from "./glyphs.js";
import { needsReviewPlainClause, retirableClause } from "./hand-rolled.js";

export type DashboardMode = "pre-adopt" | "adopted" | "fresh";

export interface DashboardFinding {
	ruleId: string;
	file: string;
	message: string;
}

export interface DashboardState {
	cwd: string;
	mode: DashboardMode;
	scaffold?: { present: number; total: number };
	findings: DashboardFinding[];
	/** Pinned `packVersion` is older than the installed CLI (#336). Renderer
	 *  folds this into the "What's wrong" line so a stale-but-healthy project
	 *  still surfaces a signal that explains why the gate will run `upgrade`.
	 *  Optional so callers not yet wired to version currency keep today's
	 *  behavior. */
	upgradeAvailable?: boolean;
	/** The retirable / needs-review split of hand-rolled DS infrastructure
	 *  findings from the read-only owned-concern scan (ADR-0003 / #504 / #639). A
	 *  "what's wrong" signal: a found defect must never read as clean. The scan
	 *  that produced this is, by definition, NOT one of `alsoChecked`. Retirable
	 *  findings render "the pack now provides"; needs-review findings render
	 *  "possible … to review" — never "now provides". Defaults to undefined. */
	handRolled?: HandRolledSplit;
	/** Labels of the read-only completeness scans that ran and came back clean
	 *  (#504). A check that passes silently is indistinguishable from one that
	 *  never ran — naming the clean scans makes the ADR-0003 completeness
	 *  promise credible. Rendered as an `Also checked: … ✓` line. */
	alsoChecked?: string[];
}

export function renderDashboard(state: DashboardState, color: ColorAdapter): string[] {
	const lines: string[] = [];

	// The three-marker vocabulary (#620): ✓ good, ! the tool can act, ✗ a
	// problem you must resolve. The glyph routes through the injected adapter so
	// it's colored on a TTY and plain (identity) when piped or under test.
	const good = (s: string): string => `${color.green(CHECK)} ${s}`;
	const action = (s: string): string => `${color.cyan("!")} ${s}`;
	// The third marker, ✗ (a problem the tool can't resolve for you), is part of
	// the agreed vocabulary but unused here: every dashboard signal today is
	// something the gate can run, so they all route through `action`. A future
	// non-actionable state renders `color.red("✗")` rather than a fourth glyph.
	const path = color.dim(state.cwd);

	// "Where you are", in words a consumer recognizes: is the design system set
	// up in this directory, or not yet? The `pre-adopt`/`adopted` mode names stay
	// internal — only this plain framing prints.
	if (state.mode === "pre-adopt") {
		lines.push(action(`Design system not set up here yet — ${path}`));
		lines.push(action("No design-system files installed yet"));
		return lines;
	}

	lines.push(good(`Design system in place — ${path}`));

	if (state.scaffold) {
		const { present, total } = state.scaffold;
		if (present === total) {
			lines.push(good(`Managed files: ${present}/${total}`));
		} else {
			const missing = total - present;
			lines.push(action(`Managed files: ${present}/${total} (${missing} missing)`));
		}
	}

	const scaffoldIncomplete =
		state.scaffold !== undefined && state.scaffold.present !== state.scaffold.total;
	const findingsCount = state.findings.length;
	const upgradeAvailable = state.upgradeAvailable === true;
	const handRolled = state.handRolled;
	const handRolledTotal = handRolled?.total ?? 0;

	if (!scaffoldIncomplete && findingsCount === 0 && !upgradeAvailable && handRolledTotal === 0) {
		lines.push(good("Everything's up to date — nothing to fix"));
	} else {
		// Missing files, fixable issues, a stale pack, and scripts the consumer
		// built by hand (ADR-0003) are all "needs attention" signals. Surfacing
		// only some would let a `0/12` line co-exist with an "up to date" claim,
		// which the renderer must never say. Each part is phrased by what the
		// consumer would recognize, not the internal finding category.
		const parts: string[] = [];
		if (scaffoldIncomplete && state.scaffold) {
			const missing = state.scaffold.total - state.scaffold.present;
			parts.push(`${missing} missing ${missing === 1 ? "file" : "files"}`);
		}
		if (findingsCount > 0) {
			parts.push(`${findingsCount} ${findingsCount === 1 ? "issue" : "issues"} I can fix`);
		}
		// #639: the single "scripts the pack now provides" line splits in two.
		// "Now provides" is honest only for retirable findings (a live capability
		// supersedes them); needs-review findings are flagged "to review", never
		// promised a retirement. The noun derives from the set (file/finding),
		// never the hardcoded "script". Plain dialect (#620) — no "hand-rolled".
		if (handRolled && handRolled.retirable > 0) {
			parts.push(retirableClause(handRolled));
		}
		if (handRolled && handRolled.needsReview > 0) {
			parts.push(needsReviewPlainClause(handRolled));
		}
		// #644: pack-currency is its own fact, never comma-spliced onto the
		// findings/hand-rolled roll-up. "3 missing files, …, a newer pack is
		// available" read as one run-on claim; the upgrade now carries its own
		// line so each line carries one message. The roll-up line is suppressed
		// when an available update is the *only* signal (`parts` empty).
		if (parts.length > 0) {
			lines.push(action(`Needs attention: ${parts.join(", ")}`));
		}
		if (upgradeAvailable) {
			lines.push(action("A newer design-system pack is available"));
		}
	}

	// Name the read-only completeness scans that ran clean (#504). A check that
	// passes silently is indistinguishable from one that never ran — so the
	// scans that came back clean are listed explicitly, even alongside other
	// "needs attention" signals. A scan that found something is, by construction,
	// absent from this list (it's a "needs attention" signal instead).
	if (state.alsoChecked && state.alsoChecked.length > 0) {
		lines.push(good(`Also checked: ${state.alsoChecked.join(", ")}`));
	}

	return lines;
}
