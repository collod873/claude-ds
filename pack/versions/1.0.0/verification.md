# v1.0.0 Verification Report

Run date: 2026-05-25
Script: `scripts/verify-v1.sh`
Consumer: Crewops (baseline v0.7.13)

## Results: 24 passed, 0 failed

```
✓ [Phase 0] Crewops at v0.7.13 baseline
✓ [Phase 1] .states.json files exist (baseline) — 92 files
✓ [Phase 1] STATE-001 exceptions exist (baseline) — 90 entries
✓ [Phase 1] manifest.generated.ts exists (baseline)
✓ [Phase 2] Dry-run completed without errors
✓ [Phase 2] Migration chain includes v0.8.0 → v0.9.0
✓ [Phase 3] packVersion updated to v1.0.0
✓ [Phase 4] .states.json files removed (count: 0)
✓ [Phase 4] STATE-001 exceptions removed (count: 0)
✓ [Phase 4] force-state.css exists
✓ [Phase 5] manifest.generated.ts removed
✓ [Phase 5] @ds/* imports present (count: 4)
✓ [Phase 6] audit exits 0 (no unexpected drift)
✓ [Phase 6] doctor --completeness exits 0
✓ [Phase 8] greenfield init --pack next-react succeeded
✓ [Phase 8] greenfield doctor --completeness passes
✓ [Phase 8] design-system/atoms exists
✓ [Phase 8] design-system/composites exists
✓ [Phase 8] design-system/references exists
✓ [Phase 8] tokens.json exists
✓ [Phase 9] component skill installed
✓ [Phase 9] pattern skill installed
✓ [Phase 9] design-system skill installed
✓ [Phase 10] pack/versions/1.0.0/breaking.md exists
```

## HITL items completed separately

- Phase 7: Superseded scripts deleted from Crewops (5 scripts, 3 package.json entries)
- Phase 9: Skill scaffold testing deferred (skills confirmed installed; functional testing TBD)
