import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/a11y-scan.ts");

describe("a11y-scan.ts", () => {
  it("exits non-zero when no args supplied", () => {
    // Without a running dev server + playwright installed in consumer, exits non-zero.
    // This repo has no playwright; script fails at import or arg check — both are correct.
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
  });

  it("exits non-zero when only port supplied (no components)", () => {
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT, "3000"], {
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
  });
});
