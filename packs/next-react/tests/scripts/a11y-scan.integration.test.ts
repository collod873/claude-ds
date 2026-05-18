import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/a11y-scan.ts");

describe("a11y-scan.ts [integration]", () => {
  it("exits non-zero when no args supplied", () => {
    // In consumer repos playwright is installed; here we only verify the script
    // refuses cleanly without a running server + proper args.
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
