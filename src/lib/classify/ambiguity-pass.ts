import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import { info, err } from "../log.js";
import { type CommandResult, commandError } from "../command-result.js";
import { loadProject } from "../project.js";
import { classifySource } from "../classifier.js";
import { makeTtyPrompt, type FixerPrompt } from "../drift/index.js";
import { parseExceptions, type Exception } from "../exceptions.js";
import { run } from "../runner.js";
import { moveTierFile } from "../ops/move-tier-file.js";
import { appendExceptions } from "../ops/append-exceptions.js";
import type { Operation } from "../operation.js";
import {
  resolveDecisions,
  UnresolvedAmbiguityError,
  type AnswerBag,
  type Decision,
  type PendingDecision,
} from "../decision/index.js";
import { COMPANION_SUFFIXES, type MovePlan } from "./scan.js";

/**
 * Ambiguity pass (ADR-0015, issue #203, PRD #241 / #244, issue #251):
 * Walk design-system/atoms/ and re-classify each file using classifySource —
 * the same function and arguments that audit's placement-drift rules use, so
 * the two sides share one boundary.
 *
 * Two bands, two behaviours:
 *   confident composite  (tier=composite, !ambiguous): auto-move unconditionally —
 *     no prompt, no TTY gate.  This is what audit's DRIFT-MISPLACED and
 *     DRIFT-MISCLASSIFIED-ATOM fire on; leaving them in atoms/ makes audit
 *     diverge from classify.
 *   ambiguous composite  (tier=composite, ambiguous=true, 1-2 DS imports):
 *     prompt the user when interactive; skip silently when non-interactive
 *     (audit also skips these, so no convergence gap).
 *
 * Hoisted out of classifyCmd so it runs even when --src has no new files to
 * classify (the common re-run case: audit flagged a misplaced composite, user
 * re-runs classify to resolve it, but src is already migrated).
 */
export async function applyAmbiguityPass(params: {
  cwd: string;
  domainRoots: string[];
  allowedImports: string[];
  dsAliases: string[];
  suppliedAnswers: AnswerBag;
  /** Test-injected ambiguity prompt; CLI leaves undefined and a TTY prompt is built. */
  prompt?: FixerPrompt;
  /** When set, unresolved Ambiguity Decisions are collected here instead of throwing. */
  pendingSink?: PendingDecision[];
}): Promise<{ moved: number; kept: number } | CommandResult> {
  const { cwd, domainRoots, allowedImports, dsAliases, suppliedAnswers } = params;

  // Ambiguous-band prompt source: a test-injected `params.prompt` overrides
  // everything; otherwise the TTY prompt is used iff stdout is a TTY. Used
  // as the resolver's TTY callback below — the spine drives the question;
  // this callback only owns the read.
  const ambiguityPrompt: FixerPrompt | null =
    params.prompt ?? (process.stdout.isTTY === true ? makeTtyPrompt() : null);
  const promptAvailable = ambiguityPrompt !== null;

  let movedCount = 0;
  let keptCount = 0;
  const atomAbs = join(cwd, "design-system/atoms");
  let atomEntries: Dirent[] = [];
  try {
    atomEntries = await readdir(atomAbs, { withFileTypes: true });
  } catch {
    atomEntries = [];
  }
  const exceptionsToAdd: Exception[] = [];
  const ambiguityMoves: MovePlan[] = [];

  // Two phases:
  //   1. Walk atoms/, auto-move confident composites, collect the
  //      genuinely-ambiguous ones as Ambiguity Decisions.
  //   2. Route the collected Decisions through the spine resolver — TTY
  //      prompts, non-TTY with a supplied answer reads it, non-TTY without
  //      throws (ADR-0023 fail-loud; no silent default).
  interface AmbiguousAtom {
    decision: Decision;
    atomRel: string;
    fileName: string;
  }
  const ambiguousAtoms: AmbiguousAtom[] = [];

  for (const e of atomEntries) {
    if (!e.isFile() || !e.name.endsWith(".tsx")) continue;
    if (COMPANION_SUFFIXES.some(s => e.name.endsWith(s))) continue;
    const atomRel = `design-system/atoms/${e.name}`;
    let source: string;
    try {
      source = await readFile(join(cwd, atomRel), "utf8");
    } catch {
      continue;
    }

    // Use the same classifySource call (same args) that audit's three-signal
    // checker uses so classify and audit share one classification boundary.
    const verdict = classifySource(source, domainRoots, allowedImports, dsAliases);
    if (verdict.tier !== "composite") continue;

    if (!verdict.ambiguous) {
      // Confident composite: auto-move regardless of TTY / --yes.
      // This is exactly the case audit's DRIFT-MISPLACED fires on; moving it
      // unconditionally makes the flow converge without human input (issue #251).
      const destRel = `design-system/composites/${e.name}`;
      ambiguityMoves.push({ srcRel: atomRel, destRel, label: "composite — auto-relocated" });
      continue;
    }

    // Genuinely ambiguous band (1-2 DS imports): build an Ambiguity Decision
    // and let the spine resolver decide TTY vs supplied-answer vs fail-loud.
    const fileName = e.name.replace(/\.tsx$/, "");
    ambiguousAtoms.push({
      atomRel,
      fileName,
      decision: {
        id: `classify-ambiguity:${atomRel}`,
        kind: "ambiguity",
        question: `${fileName} is in atoms/ but imports multiple design-system components. Is it a simple building block (atom) or does it combine multiple components (composite)?`,
        options: [
          { label: "Keep as atom", description: "It is a self-contained building block" },
          { label: "Move to composites", description: "It combines other components and belongs in composites/" },
        ],
      },
    });
  }

  if (ambiguousAtoms.length > 0) {
    let resolved: Record<string, number | "defer">;
    try {
      // PRD #325 sub-issue #333 — heal opts INTO collect mode by passing a
      // `pendingSink`. The resolver returns pending decisions in
      // `result.pending` instead of throwing; classify treats them as
      // skipped (leave the file untouched) for this iteration. heal
      // aggregates them across iterations and surfaces an `--answers`
      // scaffold.
      const collect = params.pendingSink !== undefined;
      const result = await resolveDecisions(
        ambiguousAtoms.map(a => a.decision),
        suppliedAnswers,
        {
          // The resolver gates on `isTTY` ANDed with a non-null `prompt` —
          // treating injected prompts (test path) as TTY keeps the spine the
          // single switchboard while still honouring `params.prompt`.
          isTTY: promptAvailable,
          collect,
          prompt: ambiguityPrompt
            ? async (q, o) => ambiguityPrompt(q, o)
            : undefined,
        },
      );
      resolved = result.answers;
      if (params.pendingSink) {
        for (const pending of result.pending) params.pendingSink.push(pending);
      }
    } catch (e) {
      if (e instanceof UnresolvedAmbiguityError) {
        err(`classify needs you: decision "${e.decisionId}" — ${e.decisionQuestion}`);
        err(`Re-run with --answers <file> mapping "${e.decisionId}" to 0 (keep) or 1 (move).`);
        return commandError(2);
      }
      throw e;
    }

    for (const a of ambiguousAtoms) {
      const answer = resolved[a.decision.id];
      if (answer === 1) {
        const destRel = `design-system/composites/${basename(a.atomRel)}`;
        ambiguityMoves.push({
          srcRel: a.atomRel,
          destRel,
          label: "composite — user confirmed",
        });
      } else if (answer === 0) {
        // Keep as atom — suppress audit's ambiguity findings for this file
        // going forward. Above the confidence threshold the classifier
        // verdict is "composite" (unambiguous), so both DRIFT-MISPLACED and
        // DRIFT-MISCLASSIFIED-ATOM would fire on subsequent audits; the
        // user's "keep" decision overrides both (PRD #241 / #244).
        const reason =
          "classify: user confirmed atom despite multiple component imports";
        exceptionsToAdd.push({
          rule: "DRIFT-MISPLACED",
          path: a.atomRel,
          reason,
          permanent: true,
        });
        exceptionsToAdd.push({
          rule: "DRIFT-MISCLASSIFIED-ATOM",
          path: a.atomRel,
          reason,
          permanent: true,
        });
        keptCount++;
        info(`classify: ${a.atomRel} — kept as atom (suppressing future ambiguity findings)`);
      } else {
        // "defer"/skip — leave the file untouched; audit will surface it
        // again next run.
        info(`classify: ${a.atomRel} — skipped (will be flagged again on next audit)`);
      }
    }
  }

  if (ambiguityMoves.length > 0) {
    const ctxAmb = await loadProject(cwd);
    const ops: Operation[] = ambiguityMoves.map(p =>
      moveTierFile(p.srcRel, p.destRel, { kind: "composite" }),
    );
    const report = await run(ctxAmb, ops, "apply");
    const planBySrc = new Map(ambiguityMoves.map(p => [p.srcRel, p]));
    for (const c of report.applied) {
      if (c.kind !== "rename") continue;
      const p = planBySrc.get(c.path);
      if (!p) continue;
      info(`classify: ${p.srcRel} → ${p.destRel} (${p.label})`);
      movedCount++;
    }
    if (report.failed) {
      err(`classify: ${report.failed.error}`);
    }
  }

  if (exceptionsToAdd.length > 0) {
    const exceptionsPath = join(cwd, "design-system/exceptions.json");
    let existing: Exception[] = [];
    try {
      existing = parseExceptions(await readFile(exceptionsPath, "utf8"));
    } catch {
      existing = [];
    }
    const ctxEx = await loadProject(cwd);
    await run(ctxEx, [appendExceptions([...existing, ...exceptionsToAdd])], "apply");
    info(`classify: ${exceptionsToAdd.length} ambiguity exception(s) written to design-system/exceptions.json`);
  }

  if (movedCount > 0) {
    // Relocations changed import paths — rewrite again so references stay resolvable.
    const { rewriteImports } = await import("../ops/rewrite-imports.js");
    const ctx4 = await loadProject(cwd);
    await run(ctx4, [rewriteImports], "apply");

    // Regenerate barrel index files (atoms/index.ts, composites/index.ts, etc.)
    // so that a file moved from atoms/ to composites/ is no longer re-exported
    // from the old tier barrel — a stale barrel export would cause TS2307 on the
    // next tsc run even though audit reports 0 findings (ADR-0015, #264).
    const { regenIndexes } = await import("../finalizers/regen-indexes.js");
    const ctx5 = await loadProject(cwd);
    const indexChanges = await regenIndexes(ctx5);
    if (indexChanges.length > 0) {
      const regenOp = {
        name: "classify-regen-indexes",
        plan: async () => indexChanges,
      };
      await run(ctx5, [regenOp], "apply");
    }
  }

  return { moved: movedCount, kept: keptCount };
}
