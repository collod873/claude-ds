import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, stat, access } from "node:fs/promises";
import { join } from "node:path";

// #470 — the retired `migrate <path>` command moved one named component into the
// managed layout. classify (run by the driver) now owns extraction (ADR-0015),
// and these tests pin that `classify --src <file>` covers the single-file move
// migrate served (prime directive: never remove a capability a consumer relies
// on). The `--tier`-forcing + exception-registration escape hatch migrate also
// carried is dropped — a consumer who wants to force a misplacement places the
// file and sanctions the resulting DRIFT-MISPLACED via `audit --except`.

const BASE_CFG = {
  packVersion: "v0.8.0",
  pack: "next-react",
  mode: "warn",
  enforce_threshold: 10,
  removed: [],
  lookalike_ignore: [],
  app_dir: "app",
  claude_md_target: ".claude/CLAUDE.md",
  domain_roots: ["features", "lib"],
};

describe("classify --src <file> (single-file, #470)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshTmpDir();
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await mkdir(join(dir, "src/components"), { recursive: true });
  });
  afterEach(async () => { await cleanup(dir); });

  it("moves a no-import component into design-system/atoms/", async () => {
    await writeFile(join(dir, "src/components/button.tsx"), "export const Button = () => null;");
    const r = await runCli(["classify", "--src", "src/components/button.tsx", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    await stat(join(dir, "design-system/atoms/button.tsx"));
    await expect(access(join(dir, "src/components/button.tsx"))).rejects.toThrow();
  });

  it("places a composite-importing component into design-system/composites/", async () => {
    await writeFile(
      join(dir, "src/components/panel.tsx"),
      `import { Card } from "@/design-system/composites/card";\nexport const Panel = () => null;`,
    );
    const r = await runCli(["classify", "--src", "src/components/panel.tsx", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    await stat(join(dir, "design-system/composites/panel.tsx"));
  });

  it("dry-run previews the single-file move without mutating", async () => {
    await writeFile(join(dir, "src/components/badge.tsx"), "export const Badge = () => null;");
    const r = await runCli(["classify", "--src", "src/components/badge.tsx", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/badge\.tsx/);
    await expect(access(join(dir, "src/components/badge.tsx"))).resolves.toBeUndefined();
    await expect(access(join(dir, "design-system/atoms/badge.tsx"))).rejects.toThrow();
  });

  it("errors when the --src file does not exist", async () => {
    const r = await runCli(["classify", "--src", "src/components/missing.tsx", "--yes"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not found/i);
  });

  it("skips a pattern/unknown-tier file in place (does not move it)", async () => {
    // The single-file path documents that patterns/unknowns are skipped, not
    // moved. The retired `migrate` errored on these (pointing at classify);
    // classify itself reports the skip and leaves the file put (exit 0).
    await writeFile(
      join(dir, "src/components/slot.tsx"),
      "export const Slot = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;",
    );
    const r = await runCli(["classify", "--src", "src/components/slot.tsx", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/skipped/i);
    // File stays in place; nothing lands in a tier dir.
    await expect(access(join(dir, "src/components/slot.tsx"))).resolves.toBeUndefined();
    await expect(access(join(dir, "design-system/atoms/slot.tsx"))).rejects.toThrow();
    await expect(access(join(dir, "design-system/composites/slot.tsx"))).rejects.toThrow();
  });
});
