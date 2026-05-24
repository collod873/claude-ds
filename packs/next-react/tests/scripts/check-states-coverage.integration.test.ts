import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const SCRIPT = resolve("packs/next-react/files/scripts/check-states-coverage.ts");

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

  it("exit 2 with STATE-001 when states.json is empty array", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(join(atomsDir, "Label.tsx"), "export const Label = () => null;");
    await writeFile(join(atomsDir, "Label.states.json"), JSON.stringify([]));

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/STATE-001/);
  });

  it("exit 1 with STATE-000 when design-system/ is missing", () => {
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/STATE-000/);
  });
});
