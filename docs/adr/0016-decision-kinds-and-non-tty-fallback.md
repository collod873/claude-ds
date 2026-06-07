# ADR-0016: Decision kinds and the non-TTY fallback

**Status:** Accepted
**Date:** 2026-06-06
**Deciders:** Collin Lodato
**Amends:** ADR-0014 (zero-prompt audit)

## Context

ADR-0014 removed almost all interactivity: confirmation gates deleted, every
ambiguity given a safe automated default, `audit --fix` zero-prompt. The intent
was sound — a wall of jargon prompts blocked non-coder consumers. But it
overcorrected into two distinct failures, conflated under one "prompts are bad"
heuristic:

1. **The line was never drawn.** "Apply these changes?" confirmations (cheap,
   mechanical, reversible via git) and genuine project judgments (atom vs.
   composite, which token, keep which file) were treated as the same thing.
   Sessions oscillated between too many prompts and silently auto-deciding
   things that were Collin's to decide.

2. **Surviving prompts don't survive automation.** When a Claude session drives
   the CLI there is no TTY, so prompts auto-defer silently. The decision is
   never exercised, never tested, and the agent makes a project call invisibly.
   A perfectly-placed prompt that a session skips is still broken.

## Decision

Every choice the CLI surfaces is a **Decision** of one of three **kinds**, and
the *kind* — not the command — picks the behavior:

| Kind | TTY (Collin) | Non-TTY, no Decision answer |
|---|---|---|
| **Commitment gate** (apply this batch?) | colorized diff + one approve per command | auto-apply — git is the undo |
| **Ambiguity** (passes Simple question test) | prompt | **fail loud** (named, non-zero) |
| **Automatable** | silent safe default | silent safe default |

Supporting rules:

- **One commitment gate per command.** `classify`'s per-bucket confirm collapses
  to a single preview-and-approve. `--yes` skips, `--dry-run` previews.
- **Decision answers make Ambiguities testable.** A pre-supplied answer keyed by
  Decision `id` (`ctx.decisions`, loadable via `--answers`) resolves a Decision
  without a TTY. This is both the agent-supply path and the test seam — feed
  answers, assert outcomes; the prompt render is a pure function, snapshot-tested
  separately. No pseudo-TTY needed.
- **Non-TTY Ambiguity fails loud, never silently defaults.** This is the
  deliberate reversal of ADR-0014's "every ambiguity gets a safe default." The
  agent does not make project decisions that were Collin's to make.
- **Headless `heal` collects, it does not halt.** `heal` converges everything
  Automatable to a partial fixed point, gathers the unresolved Ambiguities as
  **Pending decisions**, and exits non-zero with an "N decisions need you" report
  plus an `--answers` scaffold to fill and re-run. It neither halts on the first
  Ambiguity nor silently guesses.

The **Simple question test** (ADR-0014) is unchanged — it is exactly the gate
that sorts Ambiguity from Automatable. What changes is the fallback when a
genuine Ambiguity meets no human.

## Consequences

- A headless `heal` on a brownfield baseline with a true 50/50 can now exit
  non-zero with Pending decisions instead of converging green. This is intended:
  CI-green no longer implies "no human judgment was silently made." Sandcastle
  automation must treat a Pending-decision exit as "needs Collin," not failure.
- The brownfield interventions metric (ADR-0014) sharpens: a Pending decision
  answered via `--answers` is *use*, not an Intervention.
- Existing fixer decision machinery (`describeDecisions`, `fixerChoices`,
  `makeTtyPrompt`) generalizes from audit fixers to all commands rather than
  being rebuilt.
- The non-TTY auto-defer-to-`exceptions.json` path for interactive findings is
  retired for genuine Ambiguities; exceptions remain for sanctioned drift, not
  for hiding an unanswered question.
</content>
</invoke>
