import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("audit", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("reports missing scaffold paths in a virgin tree (read-only)", async () => {
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/missing: \.claude\/settings\.json/);
    expect(r.stdout).toMatch(/missing: design-system\/contracts\.md/);
  });

  it("--suggest-removals lists ad-hoc files but mutates nothing", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/ad-hoc.tsx"), "");
    const r = await runCli(["audit", "--pack", "next-react", "--suggest-removals"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/suggest-removals/);
  });

  it("reads pack from .claude-ds.json when --pack is omitted", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["audit"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/missing: \.claude\/settings\.json/);
  });

  it("errors with exit 2 when --pack omitted and no .claude-ds.json", async () => {
    const r = await runCli(["audit"], { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--pack required/);
  });

  // #29: unexpected-file detection under managed roots

  it("flags a file under managed root that is not in the manifest", async () => {
    // Seed a skill dir not in the manifest (simulates Crewops pre-adopt extras)
    await mkdir(join(dir, ".claude/skills/badge-system"), { recursive: true });
    await writeFile(join(dir, ".claude/skills/badge-system/SKILL.md"), "# badge-system");
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/unexpected: \.claude\/skills\/badge-system\/SKILL\.md/);
    expect(r.stdout).toMatch(/may be user-authored extension/);
  });

  it("suppresses unexpected file when path matches lookalike_ignore in .claude-ds.json", async () => {
    // Seed the same unexpected file…
    await mkdir(join(dir, ".claude/skills/badge-system"), { recursive: true });
    await writeFile(join(dir, ".claude/skills/badge-system/SKILL.md"), "# badge-system");
    // …but suppress it via project config
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({
        version: "v0.0.0",
        pack: "next-react",
        mode: "warn",
        lookalike_ignore: [".claude/skills/badge-system/**"],
      }),
    );
    const r = await runCli(["audit"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/unexpected: \.claude\/skills\/badge-system/);
  });

  it("reports clean (no unexpected lines) when managed roots contain only manifest files", async () => {
    // Seed exactly one manifest-listed file
    await mkdir(join(dir, "design-system"), { recursive: true });
    await writeFile(join(dir, "design-system/contracts.md"), "# contracts");
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/unexpected:/);
  });

  // #57: per-root strictness — open roots (atoms, composites) must not flag user content
  it("does NOT flag user-authored atoms as unexpected (open root)", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(join(dir, "design-system/atoms/switch.tsx"), "export {}");
    await writeFile(join(dir, "design-system/atoms/table.tsx"), "export {}");
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/unexpected: design-system\/atoms\/switch\.tsx/);
    expect(r.stdout).not.toMatch(/unexpected: design-system\/atoms\/table\.tsx/);
  });

  it("does NOT flag user-authored composites as unexpected (open root)", async () => {
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    // Import from atoms/ so the classifier agrees with composites/ location (no drift).
    await writeFile(
      join(dir, "design-system/composites/data-table.tsx"),
      `import { Button } from "@/design-system/atoms/button";\nexport function DataTable() { return <Button />; }`,
    );
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/unexpected: design-system\/composites\/data-table\.tsx/);
  });

  it("still flags unexpected files under strict roots (.claude/skills)", async () => {
    await mkdir(join(dir, ".claude/skills/badge-system"), { recursive: true });
    await writeFile(join(dir, ".claude/skills/badge-system/SKILL.md"), "# badge-system");
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/unexpected: \.claude\/skills\/badge-system\/SKILL\.md/);
  });

  // #106: graduated audit — drift findings, exceptions, exit codes, grouped output
  it("exits 1 when unsuppressed drift findings exist", async () => {
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    // No DS imports in composites/ → classifier says atom → DRIFT-MISPLACED
    await writeFile(
      join(dir, "design-system/composites/solo-label.tsx"),
      "export function SoloLabel() { return <span />; }",
    );
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/DRIFT-MISPLACED/);
    expect(r.stdout).toMatch(/solo-label\.tsx/);
  });

  it("exits 0 when all drift findings suppressed by exceptions.json", async () => {
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await writeFile(
      join(dir, "design-system/composites/solo-label.tsx"),
      "export function SoloLabel() { return <span />; }",
    );
    await writeFile(
      join(dir, "design-system/exceptions.json"),
      JSON.stringify({
        exceptions: [
          { rule: "DRIFT-MISPLACED", path: "design-system/composites/solo-label.tsx", issue: "#1" },
        ],
      }),
    );
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/solo-label\.tsx/);
    expect(r.stdout).toMatch(/no drift findings/);
  });

  it("groups findings by rule ID in output", async () => {
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await writeFile(
      join(dir, "design-system/composites/solo-label.tsx"),
      "export function SoloLabel() { return <span />; }",
    );
    await writeFile(
      join(dir, "design-system/composites/another-solo.tsx"),
      "export function AnotherSolo() { return <div />; }",
    );
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(1);
    // Single [DRIFT-MISPLACED] header groups both findings
    expect(r.stdout).toMatch(/\[DRIFT-MISPLACED\]/);
    expect(r.stdout).toMatch(/solo-label\.tsx/);
    expect(r.stdout).toMatch(/another-solo\.tsx/);
  });

  it("suppresses only matching rule+path combo from exceptions.json", async () => {
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await writeFile(
      join(dir, "design-system/composites/solo-label.tsx"),
      "export function SoloLabel() { return <span />; }",
    );
    await writeFile(
      join(dir, "design-system/composites/another-solo.tsx"),
      "export function AnotherSolo() { return <div />; }",
    );
    // Suppress only solo-label, not another-solo
    await writeFile(
      join(dir, "design-system/exceptions.json"),
      JSON.stringify({
        exceptions: [
          { rule: "DRIFT-MISPLACED", path: "design-system/composites/solo-label.tsx", issue: "#1" },
        ],
      }),
    );
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).not.toMatch(/solo-label\.tsx/);
    expect(r.stdout).toMatch(/another-solo\.tsx/);
  });

  it("fires DRIFT-DS-IMPORTS-FEATURE for DS file importing from features/", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(
      join(dir, "design-system/atoms/invoice-label.tsx"),
      `import { fmt } from "../../features/billing/format";\nexport function InvoiceLabel() { return <span />; }`,
    );
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/DRIFT-DS-IMPORTS-FEATURE/);
    expect(r.stdout).toMatch(/invoice-label\.tsx/);
  });
});
