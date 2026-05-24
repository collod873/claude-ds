# ADR-0012: GitHub Actions agent workflow

## Status

Accepted

## Date

2026-05-24

## Context

claude-ds previously used a local RALPH orchestrator (`main.mts`) with Podman containers for AFK agent work. This required a machine to be running, used Docker isolation that added complexity, and supported a parallel planner→implement→review→merge loop that was fragile in practice.

Matt Pocock's production system in `mattpocock/course-video-manager` demonstrates a simpler, proven pattern: GitHub Actions workflows triggered by label events, sequential execution, no Docker sandbox (ephemeral runners are already isolated), and `AGENT_PAT` (a GitHub PAT) for workflow chaining.

## Decision

Replace the local RALPH orchestrator with GitHub Actions label-driven workflows. Five workflows:

1. **agent-implement** — single issue, triggered by `agent:implement` label on issues
2. **agent-implement-prd** — PRD sequential chaining, same trigger on issues with sub-issues
3. **agent-review** — PR review, triggered by `agent:review` label on PRs
4. **agent-implement-pr** — address PR feedback, triggered by `agent:implement` label on PRs
5. **agent-update-branch** — merge/rebase conflicts, triggered by `agent:update-branch` label on PRs

All use `@ai-hero/sandcastle` with `noSandbox()` and `claude-opus-4-6`. Auth via `CLAUDE_CODE_OAUTH_TOKEN` (Claude Max OAuth) and `AGENT_PAT` (GitHub PAT with repo scope for workflow chaining).

The RALPH artifacts (`main.mts`, root-level prompts, `Containerfile`) are retained as fallback — not deleted.

## Consequences

- Agent work runs on GitHub infrastructure; no local machine required
- Sequential execution eliminates merge-conflict complexity from parallelism
- Label-driven state machine is visible in the GitHub UI
- `AGENT_PAT` is required for workflow chaining (label adds by `GITHUB_TOKEN` don't trigger downstream workflows)
- The planner phase is eliminated; human does triage and issue decomposition interactively
