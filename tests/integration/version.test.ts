import { describe, it, expect } from "vitest";
import { runCli } from "../helpers/runcli";

describe("claude-ds version (smoke)", () => {
  it("prints something containing a v-prefixed semver to stdout and exits 0", async () => {
    const r = await runCli(["version"], { cwd: process.cwd() });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/v\d+\.\d+\.\d+/);
  });
});
