import { describe, it, expect } from "vitest";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * #383 — release workflow invariants. The release process used to be a
 * three-legged stool of "things the README claimed were automated but
 * weren't" — version bumps, tagging, README pinning. After #383 they're
 * all CI-driven, but the CI-driven half is invisible until it breaks.
 * These tests pin the easy-to-silently-delete pieces so a future PR can't
 * regress them without a test failure.
 *
 * #415 — tiered CI invariants. The smoke e2e is the blocking gate on every
 * PR (single-digit-minute inner loop); the heavy multi-fixture / per-command
 * matrix only runs on the nightly + release-tag gate so the inner loop stays
 * fast. `auto-tag` is wired to the smoke gate so a representative consumer
 * ending up broken can never reach a release tag.
 */

const ROOT = resolve(__dirname, "../..");

async function readWorkflow(name: string): Promise<string> {
  return await readFile(resolve(ROOT, ".github/workflows", name), "utf8");
}

async function workflowExists(name: string): Promise<boolean> {
  try {
    await access(resolve(ROOT, ".github/workflows", name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip YAML comments — everything from an unquoted `#` to end of line — so
 * assertions on workflow *behaviour* (active directives, triggers, step
 * ordering) are not confused by explanatory comments that legitimately
 * mention the old shape ("flipped from `continue-on-error: true`...").
 *
 * Approximation: we don't track quoted strings, but no current workflow
 * stores a `#` inside a YAML string literal where it would matter.
 */
function stripYamlComments(yml: string): string {
  return yml
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1").trimEnd())
    .join("\n");
}

describe("forgot-to-bump.yml (#383)", () => {
  it("runs the version-bump script", async () => {
    const yml = await readWorkflow("forgot-to-bump.yml");
    expect(yml).toMatch(/scripts\/check-version-bump\.sh/);
  });

  it("triggers on push to main (the only branch with the silent-bump-skip failure mode)", async () => {
    const yml = await readWorkflow("forgot-to-bump.yml");
    expect(yml).toMatch(/on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]/);
  });

  it("fetches full history+tags (shallow clones can't resolve the latest v* tag)", async () => {
    const yml = await readWorkflow("forgot-to-bump.yml");
    expect(yml).toMatch(/fetch-depth:\s*0/);
  });
});

describe("auto-tag.yml fail-loud signal (#383)", () => {
  it("the release job can open issues (permissions block grants issues: write)", async () => {
    const yml = await readWorkflow("auto-tag.yml");
    expect(yml).toMatch(/issues:\s*write/);
  });

  it("opens an issue when a release-path step fails", async () => {
    const yml = await readWorkflow("auto-tag.yml");
    // The guard MUST scope to the release-path: an `if: failure()` without
    // the `steps.check.outputs.exists == 'false'` clause would also fire on
    // the post-pin no-op re-trigger, which is just noise.
    expect(yml).toMatch(/if:\s*failure\(\)\s*&&\s*steps\.check\.outputs\.exists\s*==\s*'false'/);
    expect(yml).toMatch(/gh issue create/);
  });

  it("surfaces a workflow warning if `gh issue create` itself fails — never swallow", async () => {
    const yml = await readWorkflow("auto-tag.yml");
    // The whole point of fail-loud is no silent failures, including failures
    // of the loud-signal step itself.
    expect(yml).toMatch(/gh issue create.*\|\|\s*echo\s*"::warning::/s);
  });
});

describe("e2e-smoke.yml: blocking inner-loop gate (#415)", () => {
  it("is NOT configured as non-blocking — no active `continue-on-error: true` directive", async () => {
    // The previous lifecycle of the smoke harness was a non-blocking discovery
    // catalogue. Issue #415 flips it to a blocking PR gate now that A1/A2/A3
    // have landed and the harness's green invariant can be met. A regression
    // that resurrects `continue-on-error: true` silently restores the broken
    // "ships broken" loop the gate exists to kill (PRD #407).
    const yml = await readWorkflow("e2e-smoke.yml");
    // Strip YAML comments before matching — a comment may legitimately mention
    // the old directive while explaining the flip; only an active directive
    // (a line whose first non-whitespace token is `continue-on-error:`)
    // counts as a regression.
    const code = stripYamlComments(yml);
    expect(code).not.toMatch(/^\s*continue-on-error:\s*true/m);
  });

  it("has a hard inner-loop time budget — `timeout-minutes` is set and single-digit", async () => {
    // PRD #407 user story 27: a fast inner-loop gate stays in single-digit
    // minutes per PR. The job timeout is the mechanical floor that pins this —
    // no implicit GitHub-default 6-hour timeouts on the hot path.
    const yml = await readWorkflow("e2e-smoke.yml");
    const m = yml.match(/timeout-minutes:\s*(\d+)/);
    expect(m, "e2e-smoke.yml must set `timeout-minutes` for the inner-loop gate").not.toBeNull();
    const minutes = Number(m![1]);
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThan(10);
  });

  it("runs on PR + push to main (the blocking inner-loop trigger surface)", async () => {
    const yml = await readWorkflow("e2e-smoke.yml");
    expect(yml).toMatch(/pull_request:/);
    expect(yml).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
  });

  it("runs ONLY the blocking inner-loop e2e files — heavy matrix belongs in nightly", async () => {
    // The whole point of tiering: PR CI runs only the deliberate inner-loop
    // gates — `tests/e2e/smoke.test.ts` (scaffold integrity, #415) and
    // `tests/e2e/friction.test.ts` (the friction ratchet, PRD #439 user story
    // 16) — NOT the full `tests/e2e/` glob. A future per-command file added
    // under `tests/e2e/per-command/` must NOT be picked up by this workflow —
    // that would re-bloat the inner loop and defeat the tiered split.
    // Strip comments first so narrative prose that mentions `tests/e2e/` (the
    // companion heavy workflow, future fixture paths) is not misread as an
    // active vitest target.
    const code = stripYamlComments(await readWorkflow("e2e-smoke.yml"));
    // Positive: both inner-loop files ARE targets.
    expect(code).toMatch(/run:[^\n]*\btests\/e2e\/smoke\.test\.ts\b/);
    expect(code).toMatch(/run:[^\n]*\btests\/e2e\/friction\.test\.ts\b/);
    // Negative: no active `run:` directive references a `tests/e2e/...` path
    // that is NOT one of the two sanctioned inner-loop files — catches the
    // silent-re-bloat regression of someone appending the full directory or a
    // per-command sub-path to a step in this workflow. Mirrors the symmetric
    // exclusivity assertion on `e2e-release.yml` below.
    expect(code).not.toMatch(
      /run:[^\n]*\btests\/e2e\b(?!\/(smoke|friction)\.test\.ts\b)/,
    );
  });
});

describe("e2e-release.yml: heavy multi-fixture / per-command nightly+release gate (#415)", () => {
  it("exists — the tiered split needs a second gate to actually be tiered", async () => {
    expect(await workflowExists("e2e-release.yml")).toBe(true);
  });

  it("triggers on schedule (nightly) AND tag push — but NOT on every PR", async () => {
    const code = stripYamlComments(await readWorkflow("e2e-release.yml"));
    expect(code).toMatch(/schedule:/);
    expect(code).toMatch(/cron:/);
    // Tag push catches release moments the nightly might have missed.
    expect(code).toMatch(/tags:\s*\[\s*['"]?v\*['"]?\s*\]|tags:\s*\n\s*-\s*['"]?v\*['"]?/);
    // Manual fire so a maintainer can run the heavy matrix on demand.
    expect(code).toMatch(/workflow_dispatch:/);
    // The whole point of tiering: never on PR — otherwise the inner loop
    // re-bloats and the user-story-27 budget evaporates.
    expect(code).not.toMatch(/^\s*pull_request:/m);
  });

  it("has a bounded time budget — `timeout-minutes` is set on the heavy job", async () => {
    // The heavy matrix is high-coverage but high-latency; no implicit
    // GitHub-default 6-hour timeout on this path either. A run that hangs
    // (hung subprocess in the harness, never-completing fixture) should fail
    // loudly rather than burning a runner slot all night.
    const yml = await readWorkflow("e2e-release.yml");
    const m = yml.match(/timeout-minutes:\s*(\d+)/);
    expect(m, "e2e-release.yml must set `timeout-minutes` on the heavy job").not.toBeNull();
    const minutes = Number(m![1]);
    expect(minutes).toBeGreaterThan(0);
    // Generous upper bound — the heavy matrix may legitimately take longer
    // than the inner-loop gate, but a runaway above an hour is a bug.
    expect(minutes).toBeLessThanOrEqual(60);
  });

  it("runs the full e2e suite (not just the smoke) so future fixtures get picked up", async () => {
    // As `tests/e2e/per-command/*.test.ts` and additional fixtures land, they
    // must be exercised by the nightly without further workflow plumbing — so
    // the runner target is the e2e directory, not a single file.
    const code = stripYamlComments(await readWorkflow("e2e-release.yml"));
    expect(code).toMatch(/tests\/e2e\b/);
    // The active `run:` directive must not be restricted to the smoke file
    // alone — only narrative comments may reference the smoke path by name.
    expect(code).not.toMatch(/run:[^\n]*tests\/e2e\/smoke\.test\.ts\b/);
  });
});

describe("auto-tag.yml: release blocked on smoke gate green (#415)", () => {
  it("includes a build step before the test gate (so dist exists for the smoke harness)", async () => {
    // The smoke test (`tests/e2e/smoke.test.ts`) skips when `dist/cli.js`
    // is absent. `npm ci` runs the `prepare` script which calls `npm run
    // build`, so dist is present by the time `npm test` fires — but the
    // dependency is implicit. The release gate must be explicit so a future
    // package.json refactor that drops `prepare` cannot silently turn the
    // smoke gate into a skip on the release path.
    const yml = await readWorkflow("auto-tag.yml");
    // Either an explicit build step, or the prepare-via-npm-ci coupling
    // pinned by a comment that names the dependency.
    expect(yml).toMatch(/npm run build|prepare.*build|build.*prepare/i);
  });

  it("runs the full test suite as the release test gate (which includes the smoke e2e)", async () => {
    // `npm test` is `vitest run`, which runs every test file including
    // `tests/e2e/smoke.test.ts`. A red smoke harness therefore mechanically
    // fails the release path — no tag can be cut while the representative
    // consumer ends up broken (PRD #407 user story 17).
    const yml = await readWorkflow("auto-tag.yml");
    expect(yml).toMatch(/npm test/);
    // The test gate must fire on the release path before the `Tag and push`
    // step header. Match the step *header* (a `- name:` line) — not narrative
    // comment occurrences of the phrase — so explanatory prose can mention
    // `Tag and push` freely without reordering the test gate.
    const lines = yml.split("\n");
    const testGateIdx = lines.findIndex((l) => /run:\s*npm test\b/.test(l));
    const tagPushIdx = lines.findIndex((l) => /^\s*-\s*name:\s*Tag and push/.test(l));
    expect(testGateIdx).toBeGreaterThan(-1);
    expect(tagPushIdx).toBeGreaterThan(-1);
    expect(testGateIdx).toBeLessThan(tagPushIdx);
  });
});
