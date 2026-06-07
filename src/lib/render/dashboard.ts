/**
 * The dashboard renderer (PRD #325 sub-issue #330). Pure: it takes a
 * resolved `DashboardState` and returns a `string[]`. The front-door slice
 * fills the state in (composing `doctor` structural state + a read-only
 * `audit` run); this slice pins the renderer contract and the
 * representative-fixture outputs.
 *
 * The shape is intentionally minimal — three sections the PRD names ("where
 * you are / what's wrong / recommended next step") — so later slices can
 * extend it without reshaping the renderer's printout.
 */

export type DashboardMode = "pre-adopt" | "adopted" | "fresh";

export interface DashboardFinding {
  ruleId: string;
  file: string;
  message: string;
}

export interface DashboardRecommendation {
  command: string;
  description: string;
}

export interface DashboardState {
  cwd: string;
  mode: DashboardMode;
  scaffold?: { present: number; total: number };
  findings: DashboardFinding[];
  recommendedNext: DashboardRecommendation | null;
}

export function renderDashboard(state: DashboardState): string[] {
  const lines: string[] = [];

  lines.push(`Where you are: ${state.mode} (${state.cwd})`);

  if (state.scaffold) {
    const { present, total } = state.scaffold;
    const tick = present === total ? " ✓" : "";
    lines.push(`Scaffold: ${present}/${total}${tick}`);
  }

  const scaffoldIncomplete =
    state.scaffold !== undefined && state.scaffold.present !== state.scaffold.total;
  const findingsCount = state.findings.length;

  if (state.mode === "pre-adopt") {
    lines.push("What's wrong: no scaffold installed yet");
  } else if (!scaffoldIncomplete && findingsCount === 0) {
    lines.push("What's wrong: nothing — tree is clean");
  } else {
    // An incomplete scaffold and audit findings are both "what's wrong" signals.
    // Surfacing only one of them would let a `Scaffold: 0/12` line co-exist with
    // a "tree is clean" claim, which is what the renderer must not say.
    const parts: string[] = [];
    if (scaffoldIncomplete) parts.push("scaffold incomplete");
    if (findingsCount > 0) {
      const noun = findingsCount === 1 ? "finding" : "findings";
      parts.push(`${findingsCount} ${noun}`);
    }
    lines.push(`What's wrong: ${parts.join(" + ")}`);
  }

  if (state.recommendedNext) {
    lines.push(
      `→ Next: ${state.recommendedNext.command} — ${state.recommendedNext.description}`,
    );
  }

  return lines;
}
