/**
 * The dashboard brain (PRD #325 sub-issue #331). Pure: it folds doctor
 * structural state + a read-only audit's findings into the renderable
 * `DashboardState`, picking the recommended next command the same way
 * `printNextStep` does — the dashboard is that breadcrumb engine promoted
 * from "after a command" to "the front door."
 *
 * The brain lives separately from the renderer so non-TTY callers can
 * request the same shape (a future `--json` dashboard surface) and so the
 * state-→-recommendation table stays out of the orchestration code.
 */

import type {
  DashboardFinding,
  DashboardRecommendation,
  DashboardState,
} from "./render/dashboard.js";

export interface DashboardInput {
  cwd: string;
  /** `"pre-adopt"` when no `.claude-ds.json` exists; `"adopted"` otherwise. */
  mode: "pre-adopt" | "adopted";
  /** Pack name — used to format the pre-adopt `adopt --pack <name>` recommendation. */
  pack: string;
  /** From `scanScaffoldPresence` — present/total managed+seeded files. */
  scaffold: { present: number; total: number };
  /** Missing managed files in adopted mode (lookalikes are reported separately by doctor). */
  missingManaged: number;
  /** Root-level dupes of canonical design-system/ files (#23). */
  rootDupes: number;
  /** Drift + integrity findings from a read-only `scanDriftAndIntegrity` pass. */
  findings: ReadonlyArray<{ ruleId: string; file: string; message: string }>;
  /** Subset of `findings` that need extraction (classify, not audit --fix). */
  extractionCount: number;
  /** Subset of `findings` that audit cannot auto-repair (report-only relocates,
   *  unresolvable imports, deferred extraction). */
  unfixableCount: number;
  /** Detected build command — what the clean-tree recommendation invokes. */
  buildCmd: string;
  /** Pinned `packVersion` is older than the installed CLI (#336). Pre-adopt
   *  callers and up-to-date projects pass `false`; the brain only surfaces
   *  the signal in adopted mode. Defaults to `false` so callers not yet
   *  wired to version currency keep today's behavior. */
  upgradeAvailable?: boolean;
}

export function composeDashboardState(input: DashboardInput): DashboardState {
  const findings: DashboardFinding[] = input.findings.map(f => ({
    ruleId: f.ruleId,
    file: f.file,
    message: f.message,
  }));
  return {
    cwd: input.cwd,
    mode: input.mode,
    scaffold: input.scaffold,
    findings,
    upgradeAvailable:
      input.mode === "adopted" && input.upgradeAvailable === true,
    recommendedNext: recommendNextStep(input),
  };
}

function recommendNextStep(input: DashboardInput): DashboardRecommendation | null {
  if (input.mode === "pre-adopt") {
    return {
      command: `claude-ds adopt --pack ${input.pack}`,
      description: "install the design-system scaffold",
    };
  }

  // Scaffold-integrity issues outrank audit findings: `sync` and `reconcile`
  // restore the structural baseline audit assumes. Mirrors the doctor →
  // sync/reconcile order the breadcrumb engine already encodes for those
  // commands.
  if (input.missingManaged > 0) {
    return {
      command: "claude-ds sync",
      description: `restore ${input.missingManaged} missing managed file(s)`,
    };
  }
  if (input.rootDupes > 0) {
    return {
      command: "claude-ds reconcile",
      description: `resolve ${input.rootDupes} root-level duplicate(s)`,
    };
  }

  // Audit-finding triage matches `printNextStep("audit", ...)`'s priority:
  // extraction > unfixable > auto-fixable > clean. Same input → same command.
  if (input.extractionCount > 0) {
    const n = input.extractionCount;
    const noun = n === 1 ? "component" : "components";
    return {
      command: "claude-ds classify",
      description: `extract ${n} inline ${noun}`,
    };
  }
  if (input.unfixableCount > 0) {
    return {
      command: "claude-ds classify",
      description: "address findings audit can't auto-repair",
    };
  }
  if (input.findings.length > 0) {
    const n = input.findings.length;
    const noun = n === 1 ? "finding" : "findings";
    return {
      command: "claude-ds audit --fix",
      description: `auto-repair the ${n} ${noun}`,
    };
  }

  // Rank 6 — version currency. Inserted *below* structural-integrity and
  // audit triage (you do not upgrade onto a broken baseline) and *above* the
  // clean-tree build hint (a stale pack version is more actionable than
  // "everything compiles"). Mirrors the ADR-0003 heal-loop ordering
  // (sync → upgrade → classify → audit). #336.
  if (input.upgradeAvailable) {
    return {
      command: "claude-ds upgrade",
      description: "pack version is behind the installed CLI",
    };
  }

  return {
    command: input.buildCmd,
    description: "verify everything compiles",
  };
}
