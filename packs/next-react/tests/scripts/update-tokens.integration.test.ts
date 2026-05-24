import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT = resolve("packs/next-react/files/scripts/update-tokens.ts");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "int-update-tokens-"));
}

describe("update-tokens.ts [integration]", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("exit 0, writes updated tokens.json with stable sort", async () => {
    const dsDir = join(dir, "design-system");
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "tokens.json"),
      JSON.stringify({ color: { primary: "#000" } }, null, 2) + "\n"
    );

    const r = spawnSync(
      "node",
      ["--experimental-strip-types", SCRIPT, "--set", "color.accent=#f00"],
      { cwd: dir, encoding: "utf8" }
    );
    expect(r.status).toBe(0);

    const tokens = JSON.parse(await readFile(join(dsDir, "tokens.json"), "utf8"));
    expect(tokens.color.accent).toBe("#f00");
    expect(tokens.color.primary).toBe("#000");
  });

  it("exit 2, stderr TOK-000 in contract format when --set absent", async () => {
    const dsDir = join(dir, "design-system");
    await mkdir(dsDir, { recursive: true });

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^[^:]+:\d+: TOK-000: /m);
  });

  it("creates tokens.json when it does not exist", async () => {
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

  it("output has stable key order, 2-space indent, trailing newline", async () => {
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
    expect(raw).toMatch(/^  "/m);
    expect(raw.endsWith("\n")).toBe(true);
  });
});
