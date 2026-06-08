import type { Meta } from "@ds/types/meta";

// Presentational atom — pure render, no domain logic. Sanitized snapshot of a
// real Crewops atom: the labels/states are reduced to placeholder tokens, the
// shape is preserved verbatim.
export function StatusBadge(props: { tone?: string; label?: string }) {
  return <span data-tone={props.tone ?? "neutral"}>{props.label ?? ""}</span>;
}

// PARSER-BREAKING SHAPE: `kind` is declared AFTER a nested brace. `examples`
// (which contains `[{ … }]`) comes first, so a naive `[^}]*` reader stops at
// the inner `}` and reads this meta as "missing kind" while the brace-aware
// fixer finds it and no-ops — the exact disagreement that wedges the
// `audit --fix` loop on real Crewops. The synthetic `crewops-shaped` fixture
// never reproduces this because every meta there puts `kind` first.
export const meta: Meta = {
  examples: [
    {
      name: "default",
      props: { tone: "neutral", label: "" },
    },
    {
      name: "active",
      props: { tone: "positive", label: "" },
    },
  ],
  kind: "atom",
};
