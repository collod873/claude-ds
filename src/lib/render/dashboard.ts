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

  if (state.mode === "pre-adopt") {
    lines.push("What's wrong: no scaffold installed yet");
  } else if (state.findings.length === 0) {
    lines.push("What's wrong: nothing — tree is clean");
  } else {
    const n = state.findings.length;
    const noun = n === 1 ? "finding" : "findings";
    lines.push(`What's wrong: ${n} ${noun}`);
  }

  if (state.recommendedNext) {
    lines.push(
      `→ Next: ${state.recommendedNext.command} — ${state.recommendedNext.description}`,
    );
  }

  return lines;
}
