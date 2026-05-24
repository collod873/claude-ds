import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/check-hook-contract.sh");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "int-hook-contract-"));
}

describe("check-hook-contract.sh [integration]", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("exit 0, no stderr when all hooks have guarded exit 2s", async () => {
    const hooksDir = join(dir, ".claude", "hooks");
    await mkdir(hooksDir, { recursive: true });
    await writeFile(
      join(hooksDir, "ok.sh"),
      `#!/usr/bin/env bash\nbash .claude/hooks/lib/log-failure.sh "A" "b" "0" "c"\nexit 2\n`
    );

    const r = spawnSync("bash", [SCRIPT, hooksDir], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exit 2, stderr HOOK-001 in contract format when unguarded exit 2 found", async () => {
    const hooksDir = join(dir, ".claude", "hooks");
    await mkdir(hooksDir, { recursive: true });
    await writeFile(
      join(hooksDir, "bad.sh"),
      `#!/usr/bin/env bash\necho "problem" >&2\nexit 2\n`
    );

    const r = spawnSync("bash", [SCRIPT, hooksDir], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^[^:]+:\d+: HOOK-001: /m);
  });

  it("exit 0 when hooks dir is empty", async () => {
    const hooksDir = join(dir, ".claude", "hooks");
    await mkdir(hooksDir, { recursive: true });

    const r = spawnSync("bash", [SCRIPT, hooksDir], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });
});
