import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/update-tokens.ts");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "update-tokens-"));
}

describe("update-tokens.ts", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("happy path: sets a nested key and writes tokens.json", async () => {
    const dsDir = join(dir, "design-system");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "tokens.json"),
      JSON.stringify({ color: { primary: "#0070f3" } }, null, 2) + "\n"
    );

    const r = spawnSync(
      "node",
      ["--experimental-strip-types", SCRIPT, "--set", "color.secondary=#ff0000"],
      { cwd: dir, encoding: "utf8" }
    );
    expect(r.status).toBe(0);

    const written = JSON.parse(await readFile(join(dsDir, "tokens.json"), "utf8"));
    expect(written.color.secondary).toBe("#ff0000");
    expect(written.color.primary).toBe("#0070f3");
  });

  it("happy path: creates tokens.json when it does not exist", async () => {
    const dsDir = join(dir, "design-system");
    await mkdir(dsDir, { recursive: true });

    const r = spawnSync(
      "node",
      ["--experimental-strip-types", SCRIPT, "--set", "color.primary=#ffffff"],
      { cwd: dir, encoding: "utf8" }
    );
    expect(r.status).toBe(0);

    const written = JSON.parse(await readFile(join(dsDir, "tokens.json"), "utf8"));
    expect(written.color.primary).toBe("#ffffff");
  });

  it("happy path: output has stable key order and 2-space indent", async () => {
    const dsDir = join(dir, "design-system");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "tokens.json"),
      JSON.stringify({ z: 1, a: 2 }, null, 2) + "\n"
    );

    const r = spawnSync(
      "node",
      ["--experimental-strip-types", SCRIPT, "--set", "m=3"],
      { cwd: dir, encoding: "utf8" }
    );
    expect(r.status).toBe(0);

    const raw = await readFile(join(dsDir, "tokens.json"), "utf8");
    const keys = Object.keys(JSON.parse(raw));
    expect(keys).toEqual([...keys].sort());
    // 2-space indent
    expect(raw).toMatch(/^  "/m);
    // trailing newline
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("refusal path: exits 2 with TOK-000 when no --set provided", async () => {
    const dsDir = join(dir, "design-system");
    await mkdir(dsDir, { recursive: true });

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/TOK-000/);
  });
});
