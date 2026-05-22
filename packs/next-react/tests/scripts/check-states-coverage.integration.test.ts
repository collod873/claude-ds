import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { copyFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";

const SCRIPT = resolve("packs/next-react/files/scripts/check-states-coverage.ts");
const GENERATOR = resolve("packs/next-react/files/scripts/generate-showcase-companion.ts");
const FIXTURE_ATOM = resolve("packs/next-react/tests/fixtures/showcase-companion-atom-meta");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "int-states-"));
}

describe("check-states-coverage.ts [integration]", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("exit 0 when all components covered", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(join(atomsDir, "Chip.tsx"), "");
    await writeFile(join(atomsDir, "Chip.states.json"), JSON.stringify([{ name: "default" }]));

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exit 0 when states.json uses wrapped { __generated, states: [...] } shape", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(join(atomsDir, "Chip.tsx"), "");
    await writeFile(
      join(atomsDir, "Chip.states.json"),
      JSON.stringify({
        __generated: { by: "test", from: "Chip.tsx" },
        states: [{ label: "default", props: {} }],
      })
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exit 2 when wrapped shape has empty states array", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(join(atomsDir, "Chip.tsx"), "");
    await writeFile(
      join(atomsDir, "Chip.states.json"),
      JSON.stringify({ __generated: { by: "test" }, states: [] })
    );

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/STATE-001/);
  });

  it("end-to-end: generator output is accepted by analyzer (regression for #75)", async () => {
    // Run generator against atom fixture, then run analyzer over same dir.
    // Analyzer must exit 0 — generator emits wrapped { __generated, states: [...] }.
    const dsDir = join(dir, "design-system", "atoms");
    mkdirSync(dsDir, { recursive: true });
    copyFileSync(
      join(FIXTURE_ATOM, "design-system/atoms/button.tsx"),
      join(dsDir, "button.tsx")
    );

    const gen = spawnSync("node", ["--experimental-strip-types", GENERATOR], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(gen.status).toBe(0);

    const statesPath = join(dsDir, "button.states.json");
    expect(existsSync(statesPath)).toBe(true);
    // Sanity: generator currently emits wrapped shape
    const parsed = JSON.parse(readFileSync(statesPath, "utf8"));
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed).toHaveProperty("__generated");
    expect(Array.isArray(parsed.states)).toBe(true);

    const analyzer = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(analyzer.stderr).toBe("");
    expect(analyzer.status).toBe(0);
  });

  it("exit 2, stderr matches contract format <file>:<line>: STATE-001: <hint>", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(join(atomsDir, "Missing.tsx"), "");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^[^:]+:\d+: STATE-001: /m);
  });
});
