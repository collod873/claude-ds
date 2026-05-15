import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/check-hook-contract.sh");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "hook-contract-"));
}

describe("check-hook-contract.sh", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("happy path: exits 0 when all exit 2s are guarded by log-failure.sh", async () => {
    const hooksDir = join(dir, ".claude", "hooks");
    await mkdir(hooksDir, { recursive: true });
    await writeFile(
      join(hooksDir, "good-hook.sh"),
      `#!/usr/bin/env bash\nbash .claude/hooks/lib/log-failure.sh "RULE-001" "$file" "0" "fix hint"\nexit 2\n`
    );

    const r = spawnSync("bash", [SCRIPT, hooksDir], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });

  it("refusal path: exits 2 with HOOK-001 when exit 2 is unguarded", async () => {
    const hooksDir = join(dir, ".claude", "hooks");
    await mkdir(hooksDir, { recursive: true });
    await writeFile(
      join(hooksDir, "bad-hook.sh"),
      `#!/usr/bin/env bash\necho "bad" >&2\nexit 2\n`
    );

    const r = spawnSync("bash", [SCRIPT, hooksDir], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/HOOK-001/);
  });

  it("happy path: exits 0 when hooks dir is empty", async () => {
    const hooksDir = join(dir, ".claude", "hooks");
    await mkdir(hooksDir, { recursive: true });

    const r = spawnSync("bash", [SCRIPT, hooksDir], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });
});
