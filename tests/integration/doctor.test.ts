import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli.js";
import { freshTmpDir, cleanup } from "../helpers/tmpdir.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

describe("doctor", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("greenfield (no .claude-ds.json, no files): exits 0 with clean pre-adopt output", async () => {
    const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pre-adopt");
    // Should include JSON block
    expect(r.stdout).toContain("```json");
    expect(r.stdout).toContain('"mode": "pre-adopt"');
    // No missing canonicals that have lookalikes means no "Rename required" section
    expect(r.stdout).not.toContain("Rename required");
  });

  it("CrewOps-shaped project: flags lookalikes, exits 1", async () => {
    // Simulate a project with different vocabulary names
    await writeFile(join(dir, "design-tokens.json"), "{}");
    await mkdir(join(dir, "src", "components", "branded"), { recursive: true });
    await writeFile(join(dir, "src", "components", "branded", "Button.tsx"), "export const Button = () => null;");
    await writeFile(join(dir, "atom-kit-contract.md"), "# contracts");

    const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("pre-adopt");
    // Should report design-tokens.json as lookalike for tokens.json
    expect(r.stdout).toContain("design-tokens.json");
    // Should report atom-kit-contract.md as lookalike for contracts.md
    expect(r.stdout).toContain("atom-kit-contract.md");
    // JSON block should be present
    expect(r.stdout).toContain("```json");
    expect(r.stdout).toContain('"mode": "pre-adopt"');
    expect(r.stdout).toContain('"lookalike"');
  });

  it("post-adopt clean project: exits 0, reports post-adopt mode", async () => {
    // First adopt, then run doctor
    const adoptResult = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adoptResult.code).toBe(0);

    const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("post-adopt");
    expect(r.stdout).toContain("```json");
    expect(r.stdout).toContain('"mode": "post-adopt"');
  });
});
