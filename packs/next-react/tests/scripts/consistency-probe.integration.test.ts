import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/consistency-probe.sh");

describe("consistency-probe.sh [integration]", () => {
  it("stub: exit 0, stdout contains 'not yet implemented'", () => {
    const r = spawnSync("bash", [SCRIPT], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not yet implemented/i);
  });
});
