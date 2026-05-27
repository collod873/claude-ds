# Plan: Rewrite sandcastle-setup skill

## Context

The current sandcastle-setup skill copies files from claude-ds, which drifted from Matt Pocock's upstream. The new skill pulls directly from two source repos: `mattpocock/sandcastle` (clean shared utilities, 5 core operations) and `mattpocock/course-video-manager` (PRD operations not yet upstreamed). This eliminates the middleman and ensures every setup is built from known-good sources.

The skill is a **setup-only tool** — no drift detection, no update mode. Re-running overwrites everything except project-specific files (CODING_STANDARDS.md, CONTEXT.md, docs/adr/, .claude/CLAUDE.md, .sandcastle/.env).

## Steps

- [ ] **Step 1: Delete files created earlier this session** — remove the partial architecture-review and shared utility files we added to claude-ds before deciding to rewrite the skill instead.
  Files: `.sandcastle/retry-feedback.ts`, `.sandcastle/run-with-retry.ts`, `.sandcastle/run-with-extraction.ts`, `.sandcastle/architecture-review/` (entire dir), `.github/workflows/architecture-review.yml`
  Scope: claude-ds repo only — cleanup, no functional change

- [ ] **Step 2: Write SKILL.md** — replace the existing sandcastle-setup skill with the new 13-step process that fetches from upstream repos.
  Files: `~/.claude/skills/sandcastle-setup/SKILL.md`
  Scope: 13 steps covering detect → preserve → clean → fetch → adapt → install → secrets → labels → coding standards → restore → verify

- [ ] **Step 3: Write REFERENCE.md** — the file manifest, adaptation rules, labels, and preserve list. SKILL.md links to this by section anchor.
  Files: `~/.claude/skills/sandcastle-setup/REFERENCE.md`
  Scope: 7 sections: #source-urls, #file-manifest, #adaptation-rules, #workflow-adaptations, #labels, #preserve-list, #docs-adaptations

- [ ] **Step 4: Verify URLs** — spot-check that raw GitHub URLs in the manifest return 200.
  Files: (none — read-only verification)
  Scope: curl -sI against a sample of URLs from both repos

- [ ] **Step 5: Update sandcastle-adoption-blueprint.md** — update the General project blueprint to reflect the new skill's source-of-truth (sandcastle repo + CVM, not claude-ds).
  Files: `~/Claude Projects/General/sandcastle-adoption-blueprint.md`
  Scope: Update Layer 0 (skip init), Layer 2 source references, Layer 4 CVM extension notes

## Verification

- Read both SKILL.md and REFERENCE.md to confirm anchors match
- Spot-check 5+ raw GitHub URLs from the manifest return 200
- Confirm the adaptation rules match actual CVM file contents (inline `required()` signatures, `claudeCode` call patterns)

## Audit Notes

- The skill fetches from `main` branch of both repos — if Matt force-pushes or restructures, fetches break. Acceptable risk: both repos are stable, and the skill can be re-pointed.
- CVM operations adapted to use `shared/common.ts` is a code transformation step, not a pure copy. The 4 transformations are mechanical and well-defined (import swap, delete inline functions, replace const, replace constructor call). Verified against actual file contents earlier in this session.
- `go/` and `merge/` skills are Collin's originals — the skill preserves them, never overwrites. Matt has no equivalents.
- The `docs/agents/prompts/` directory (9 genericized prompt skeletons from CVM) is intentionally excluded — they're documentation, not runtime files. Keeps the setup lean.
- No `init` step — verified that `init` only scaffolds a starter skeleton that would be immediately overwritten. Skipping it saves time and avoids the Docker image build prompt.
