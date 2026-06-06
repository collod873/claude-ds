import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/similarity-check.ts");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "int-similarity-"));
}

describe("similarity-check.ts [integration]", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("exit 0 when no near-duplicates exist", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(join(atomsDir, "Button.tsx"), "");
    await writeFile(join(atomsDir, "Accordion.tsx"), "");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });

  it("exit 2, stderr SIM-001 in contract format when near-duplicate detected", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    // distance 1
    await writeFile(join(atomsDir, "Button.tsx"), "");
    await writeFile(join(atomsDir, "Buton.tsx"), "");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^[^:]+:\d+: SIM-001: /m);
  });

  it("exit 0 when short names have small absolute distance but low ratio (no false positive)", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    // "Badge" vs "Table" — distance 3 but ratio 3/5 = 0.6, should NOT flag
    await writeFile(join(atomsDir, "Badge.tsx"), "");
    await writeFile(join(atomsDir, "Table.tsx"), "");
    // "Card" vs "Kbd" — distance 3 but ratio 3/4 = 0.75, should NOT flag
    await writeFile(join(atomsDir, "Card.tsx"), "");
    await writeFile(join(atomsDir, "Kbd.tsx"), "");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });

  it("exit 2 when names are long and similar (high ratio match)", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    // "Button" vs "Buton" — distance 1, ratio 1/6 = 0.17, should flag
    await writeFile(join(atomsDir, "Button.tsx"), "");
    await writeFile(join(atomsDir, "Buton.tsx"), "");

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/SIM-001/);
  });

  it("exit 1 with SIM-000 when design-system/ is missing", () => {
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SIM-000/);
  });

  // ── #295 — per-file scoping when invoked by the PreToolUse hook ──────────────
  // The hook passes the edited file as argv[2]. Per ADR-0002 / ADR-0006, write-time
  // hooks must block on the write in front of them, never on pre-existing global
  // state in unrelated files. A pre-existing tooltip/tooltips pair must not block
  // edits to an unrelated atom (button.tsx).
  it("exit 0 when target file is unrelated to a pre-existing similar pair", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    // Pre-existing near-duplicate pair (the Crewops case).
    await writeFile(join(atomsDir, "tooltip.tsx"), "");
    await writeFile(join(atomsDir, "tooltips.tsx"), "");
    // Edit target: unrelated atom.
    await writeFile(join(atomsDir, "button.tsx"), "");

    const r = spawnSync(
      "node",
      ["--experimental-strip-types", SCRIPT, "design-system/atoms/button.tsx"],
      { cwd: dir, encoding: "utf8" }
    );
    expect(r.status).toBe(0);
  });

  it("exit 2 when target file IS one side of a similar pair", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(join(atomsDir, "tooltip.tsx"), "");
    await writeFile(join(atomsDir, "tooltips.tsx"), "");

    // Editing tooltip.tsx — it IS one side of the pair, so the hook must block.
    const r = spawnSync(
      "node",
      ["--experimental-strip-types", SCRIPT, "design-system/atoms/tooltip.tsx"],
      { cwd: dir, encoding: "utf8" }
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/SIM-001/);
  });

  it("exit 2 when no target file is provided (standalone/CI mode reports all)", async () => {
    const atomsDir = join(dir, "design-system", "atoms");
    await mkdir(atomsDir, { recursive: true });
    await writeFile(join(atomsDir, "tooltip.tsx"), "");
    await writeFile(join(atomsDir, "tooltips.tsx"), "");
    await writeFile(join(atomsDir, "button.tsx"), "");

    // No argv[2] — standalone mode (CI) still reports every near-duplicate pair.
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/SIM-001/);
  });
});
