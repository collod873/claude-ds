# ADR-0013: Audit findings must be actionable

**Status:** Accepted  
**Date:** 2026-05-24  
**Deciders:** Collin Lodato

## Context

When a brownfield project adopts claude-ds, `claude-ds audit` produces findings the consumer cannot act on. The current output is a generic message ("use design tokens instead") with no auto-fix, no specific remediation, and no distinction between fixable drift and false positives. The only escape valve is `exceptions.json`, which gets misused for things the rule shouldn't have flagged in the first place.

This makes adoption painful and erodes trust in the tool. A wall of unactionable findings is worse than no audit at all.

## Decision

Every audit rule must satisfy an actionability contract:

1. **Don't flag what you can't help with.** If the rule cannot suggest a specific remediation for a matched pattern, it must not flag it. Runtime-dynamic expressions (e.g. `style={{ width: variable }}`) are correct code, not drift.

2. **Auto-fix known patterns.** When exactly one correct fix exists, the rule must implement `fix()` and expose it via `claude-ds audit --fix`. The consumer should be able to resolve the majority of findings without manual intervention.

3. **Specific remediation guidance.** When a finding requires manual judgment, the message must say what to do — not the category of problem, but the specific replacement (e.g. "replace with `className=\"size-4\"`" or "use token `--spacing-4`").

## Implementation

Each audit rule becomes a struct with:

- `detect(file, ast)` → finding or null
- `canAutoFix(finding)` → boolean
- `fix(finding)` → rewritten source
- `remediation(finding)` → specific human-readable instruction

Priority order for rollout:

1. Eliminate false positives (stop flagging unfixable patterns)
2. Add `--fix` for rules with deterministic fixes
3. Add specific remediation messages for remaining manual findings

## Consequences

- Exceptions become rare — reserved for genuine upstream blockers with linked issues, not for "the rule is wrong about this case."
- Brownfield adoption becomes self-service: run audit, run audit --fix, read the remaining messages, done.
- Rule authors have a higher bar: shipping a detection without a fix or clear remediation is a defect.
- Existing rules need retrofit. This is incremental — each rule can be upgraded independently.
