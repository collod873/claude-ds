import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * #383 — release workflow invariants. The release process used to be a
 * three-legged stool of "things the README claimed were automated but
 * weren't" — version bumps, tagging, README pinning. After #383 they're
 * all CI-driven, but the CI-driven half is invisible until it breaks.
 * These tests pin the easy-to-silently-delete pieces so a future PR can't
 * regress them without a test failure.
 */

const ROOT = resolve(__dirname, "../..");

async function readWorkflow(name: string): Promise<string> {
  return await readFile(resolve(ROOT, ".github/workflows", name), "utf8");
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
