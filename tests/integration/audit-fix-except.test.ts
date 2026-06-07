import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";

describe("audit --fix", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("auto-fixes DRIFT-META-KIND-MISSING by appending meta.kind export", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn", meta_kind_strict: true }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      `export function Button() { return <button />; }\n`,
    );
    const r = await runCli(["audit", "--fix"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/fixed.*DRIFT-META-KIND-MISSING/i);
    expect(r.stdout).toMatch(/button\.tsx/);
    // Verify file was actually modified
    const content = await readFile(join(dir, "design-system/atoms/button.tsx"), "utf8");
    expect(content).toMatch(/export const meta.*kind.*atom/);
  });

  it("reports unfixable findings as requiring manual intervention", async () => {
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    // Feature import → classifier says feature → DRIFT-MISPLACED fixer declines (cannot relocate to feature tier)
    await writeFile(
      join(dir, "design-system/composites/solo-label.tsx"),
      'import { api } from "@/features/billing/api";\nexport function SoloLabel() { return <span>{api()}</span>; }',
    );
    // ADR-0016: this fixture also fires DRIFT-DS-IMPORTS-FEATURE, an
    // interactive rule. Pre-supply `--answers` deferring that Ambiguity so
    // audit doesn't fail loud before reaching the unfixable DRIFT-MISPLACED.
    const answersPath = join(dir, ".answers.json");
    await writeFile(answersPath, JSON.stringify({
      "DRIFT-DS-IMPORTS-FEATURE:design-system/composites/solo-label.tsx::convert:@/features/billing/api:api": "defer",
    }));
    const r = await runCli(["audit", "--pack", "next-react", "--fix", "--answers", answersPath], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/error.*require/i);
    expect(r.stdout).toMatch(/DRIFT-MISPLACED/);
  });

  it("exits 0 when --fix resolves all findings", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn", meta_kind_strict: true }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(
      join(dir, "design-system/atoms/tag.tsx"),
      `export function Tag() { return <span />; }\n`,
    );
    const r = await runCli(["audit", "--fix"], { cwd: dir });
    expect(r.code).toBe(0);
  });

  it("exits 1 when unfixable findings remain after --fix", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn", meta_kind_strict: true }),
    );
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    // Feature import → classifier says feature → MISPLACED fixer declines
    await writeFile(
      join(dir, "design-system/composites/orphan.tsx"),
      'import { api } from "@/features/billing/api";\nexport function Orphan() { return <span>{api()}</span>; }',
    );
    const answersPath = join(dir, ".answers.json");
    await writeFile(answersPath, JSON.stringify({
      "DRIFT-DS-IMPORTS-FEATURE:design-system/composites/orphan.tsx::convert:@/features/billing/api:api": "defer",
    }));
    const r = await runCli(["audit", "--fix", "--answers", answersPath], { cwd: dir });
    expect(r.code).toBe(1);
    // DRIFT-META-KIND-MISSING (fixable) is fixed, but DRIFT-MISPLACED remains
    // because the fixer cannot relocate to a feature tier.
    expect(r.stdout).toMatch(/DRIFT-MISPLACED/);
  });

  it("does not mutate files when --fix is not passed", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn", meta_kind_strict: true }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    const original = `export function Button() { return <button />; }\n`;
    await writeFile(join(dir, "design-system/atoms/button.tsx"), original);
    const r = await runCli(["audit"], { cwd: dir });
    expect(r.code).toBe(1);
    const content = await readFile(join(dir, "design-system/atoms/button.tsx"), "utf8");
    expect(content).toBe(original);
  });
});

describe("audit --except", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("creates exceptions.json with entries for each finding (non-interactive fallback)", async () => {
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await writeFile(
      join(dir, "design-system/composites/solo-label.tsx"),
      "export function SoloLabel() { return <span />; }",
    );
    const r = await runCli(["audit", "--pack", "next-react", "--except", "--reason", "tracked workaround", "--issue", "#42"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/exception.*written/i);
    const raw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.exceptions).toHaveLength(1);
    expect(parsed.exceptions[0].rule).toBe("DRIFT-MISPLACED");
    expect(parsed.exceptions[0].path).toBe("design-system/composites/solo-label.tsx");
    expect(parsed.exceptions[0].issue).toBe("#42");
    expect(parsed.exceptions[0].reason).toBe("tracked workaround");
  });

  it("supports --permanent flag to create permanent exceptions (no issue required)", async () => {
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await writeFile(
      join(dir, "design-system/composites/solo-label.tsx"),
      "export function SoloLabel() { return <span />; }",
    );
    const r = await runCli(["audit", "--pack", "next-react", "--except", "--permanent", "--reason", "architectural decision"], { cwd: dir });
    expect(r.code).toBe(0);
    const raw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.exceptions[0].permanent).toBe(true);
    expect(parsed.exceptions[0].reason).toBe("architectural decision");
  });

  it("creates bare exceptions when --except is used without --issue or --permanent", async () => {
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await writeFile(
      join(dir, "design-system/composites/solo-label.tsx"),
      "export function SoloLabel() { return <span />; }",
    );
    const r = await runCli(["audit", "--pack", "next-react", "--except", "--reason", "just a reason"], { cwd: dir });
    expect(r.code).toBe(0);
    const raw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.exceptions[0].issue).toBeUndefined();
    expect(parsed.exceptions[0].permanent).toBeUndefined();
    expect(parsed.exceptions[0].reason).toBe("just a reason");
  });

  it("appends to existing exceptions.json without overwriting", async () => {
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await writeFile(
      join(dir, "design-system/composites/solo-label.tsx"),
      "export function SoloLabel() { return <span />; }",
    );
    await writeFile(
      join(dir, "design-system/composites/another.tsx"),
      "export function Another() { return <div />; }",
    );
    // Pre-existing exceptions.json with one entry
    await writeFile(
      join(dir, "design-system/exceptions.json"),
      JSON.stringify({
        exceptions: [
          { rule: "DRIFT-MISPLACED", path: "design-system/composites/another.tsx", issue: "#10", reason: "existing" },
        ],
      }),
    );
    const r = await runCli(["audit", "--pack", "next-react", "--except", "--reason", "new workaround", "--issue", "#99"], { cwd: dir });
    expect(r.code).toBe(0);
    const raw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    const parsed = JSON.parse(raw);
    // Should have original + newly added
    expect(parsed.exceptions.length).toBeGreaterThanOrEqual(2);
    expect(parsed.exceptions.find((e: { path: string }) => e.path === "design-system/composites/solo-label.tsx")).toBeTruthy();
    expect(parsed.exceptions.find((e: { path: string }) => e.path === "design-system/composites/another.tsx")).toBeTruthy();
  });

  it("is a no-op when --except is passed but all findings are already suppressed", async () => {
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await writeFile(
      join(dir, "design-system/composites/solo.tsx"),
      "export function Solo() { return <span />; }",
    );
    await writeFile(
      join(dir, "design-system/exceptions.json"),
      JSON.stringify({
        exceptions: [
          { rule: "DRIFT-MISPLACED", path: "design-system/composites/solo.tsx", issue: "#1", reason: "existing" },
        ],
      }),
    );
    const r = await runCli(["audit", "--pack", "next-react", "--except", "--reason", "unused", "--issue", "#2"], { cwd: dir });
    expect(r.code).toBe(0);
    // exceptions.json should be unchanged — no new entries written
    const raw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.exceptions).toHaveLength(1);
    expect(r.stdout).not.toMatch(/exception.*written/i);
  });

  it("exits 0 after writing exceptions (all findings suppressed)", async () => {
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await writeFile(
      join(dir, "design-system/composites/solo.tsx"),
      "export function Solo() { return <span />; }",
    );
    const r = await runCli(["audit", "--pack", "next-react", "--except", "--reason", "wontfix", "--issue", "#1"], { cwd: dir });
    expect(r.code).toBe(0);
  });
});

describe("audit --fix --except", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("fixes fixable items first, then writes exceptions for the rest", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn", meta_kind_strict: true }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    // Missing meta.kind only → DRIFT-META-KIND-MISSING (fixable in place).
    await writeFile(
      join(dir, "design-system/atoms/tag.tsx"),
      'export function Tag() { return <span />; }\n',
    );
    // Pattern file with no slots → DRIFT-PATTERN-NO-SLOTS (unfixable)
    await mkdir(join(dir, "design-system/patterns"), { recursive: true });
    await writeFile(
      join(dir, "design-system/patterns/page-layout.tsx"),
      'export function PageLayout() { return <div />; }\nexport const meta = { kind: "pattern" as const, examples: [] };\n',
    );
    const r = await runCli(["audit", "--fix", "--except", "--reason", "pending move", "--issue", "#55"], { cwd: dir });
    expect(r.code).toBe(0);
    // Verify tag.tsx got its meta.kind appended in place.
    const content = await readFile(join(dir, "design-system/atoms/tag.tsx"), "utf8");
    expect(content).toMatch(/export const meta.*kind.*atom/);
    // Verify the unfixable DRIFT-PATTERN-NO-SLOTS was excepted
    const raw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.exceptions.some((e: { rule: string }) => e.rule === "DRIFT-PATTERN-NO-SLOTS")).toBe(true);
  });
});

describe("audit --fix stale exception cleanup", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("removes stale exceptions after a successful fix resolves the finding", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn", meta_kind_strict: true }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    // chip.tsx already has meta.kind → exception for DRIFT-META-KIND-MISSING is stale
    await writeFile(
      join(dir, "design-system/atoms/chip.tsx"),
      `export function Chip() { return <span />; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
    );
    // tag.tsx has NO meta.kind → DRIFT-META-KIND-MISSING will fire and be fixed
    await writeFile(
      join(dir, "design-system/atoms/tag.tsx"),
      `export function Tag() { return <span />; }\n`,
    );
    // Pre-existing stale exception (chip.tsx already has meta, so this exception is stale)
    await writeFile(
      join(dir, "design-system/exceptions.json"),
      JSON.stringify({
        exceptions: [
          { rule: "DRIFT-META-KIND-MISSING", path: "design-system/atoms/chip.tsx", issue: "#10", reason: "tracked" },
        ],
      }),
    );
    const r = await runCli(["audit", "--fix"], { cwd: dir });
    expect(r.code).toBe(0);
    // Verify tag.tsx got the fix (different file)
    const tagContent = await readFile(join(dir, "design-system/atoms/tag.tsx"), "utf8");
    expect(tagContent).toContain('kind: "atom"');
    // Verify the stale exception for chip.tsx was removed
    const raw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.exceptions).toHaveLength(0);
    expect(r.stdout).toMatch(/stale exception.*removed/i);
  });

  it("preserves exceptions that still fire after fixes", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn", meta_kind_strict: true }),
    );
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    // This file triggers DRIFT-MISPLACED (fixer will decline because classifier says feature)
    // and also DRIFT-META-KIND-MISSING (fixable)
    await writeFile(
      join(dir, "design-system/composites/orphan.tsx"),
      'import { api } from "@/features/billing/api";\nexport function Orphan() { return <span>{api()}</span>; }',
    );
    // Pre-existing exception for DRIFT-MISPLACED — should be preserved
    await writeFile(
      join(dir, "design-system/exceptions.json"),
      JSON.stringify({
        exceptions: [
          { rule: "DRIFT-MISPLACED", path: "design-system/composites/orphan.tsx", issue: "#20", reason: "known" },
        ],
      }),
    );
    const r = await runCli(["audit", "--fix"], { cwd: dir });
    // Even after fixing META-KIND-MISSING, MISPLACED still fires → exception stays
    const raw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.exceptions.some((e: { rule: string }) => e.rule === "DRIFT-MISPLACED")).toBe(true);
  });
});

describe("audit --fix abort handling", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => {
    try { await chmod(join(dir, "design-system/atoms"), 0o755); } catch {}
    try { await chmod(join(dir, "design-system"), 0o755); } catch {}
    await cleanup(dir);
  });

  it("exits non-zero with rollback message when fixer fails to apply", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn", meta_kind_strict: true }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      `export function Button() { return <button />; }\n`,
    );
    await chmod(join(dir, "design-system/atoms"), 0o555);

    const r = await runCli(["audit", "--fix"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/rolled back/i);
  });

  it("does not modify exceptions.json when fix pass aborts", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn", meta_kind_strict: true }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      `export function Button() { return <button />; }\n`,
    );
    const existingExceptions = JSON.stringify({
      exceptions: [
        { rule: "DRIFT-META-KIND-MISSING", path: "design-system/atoms/other.tsx", issue: "#1", reason: "test" },
      ],
    }, null, 2) + "\n";
    await writeFile(join(dir, "design-system/exceptions.json"), existingExceptions);
    await chmod(join(dir, "design-system/atoms"), 0o555);

    await runCli(["audit", "--fix"], { cwd: dir });
    const raw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    expect(raw).toBe(existingExceptions);
  });

  it("exits non-zero and rolls back when finalizer fails", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn", meta_kind_strict: true }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    const original = `export function Button() { return <button />; }\n`;
    await writeFile(join(dir, "design-system/atoms/button.tsx"), original);
    await chmod(join(dir, "design-system"), 0o555);

    const r = await runCli(["audit", "--fix"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/rolled back/i);
    const content = await readFile(join(dir, "design-system/atoms/button.tsx"), "utf8");
    expect(content).toBe(original);
  });
});

describe("audit --fix post-fix re-validation", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("catches fixer-introduced drift in the same run", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn", meta_kind_strict: true }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    // Three DS imports puts the classifier above the boundary-confidence
    // threshold (PRD #241 / #244): the verdict is unambiguously composite, so
    // DRIFT-MISPLACED fires and stays (report-only post-#242). META-KIND-MISSING
    // is fixable in place and backfills `kind: "atom"` based on location, which
    // re-validation then catches as DRIFT-MISCLASSIFIED-ATOM at the same path.
    await writeFile(
      join(dir, "design-system/atoms/card.tsx"),
      `import { Icon } from "design-system/atoms/icon";\nimport { Button } from "design-system/atoms/button";\nimport { Badge } from "design-system/atoms/badge";\nexport function Card() { return <div><Icon /><Button /><Badge /></div>; }\n`,
    );
    const r = await runCli(["audit", "--fix"], { cwd: dir });
    // Re-validation should catch new findings introduced by the in-place fix.
    expect(r.stdout).toMatch(/re-validation/);
    expect(r.code).toBe(1);
  });

  it("skips re-validation when fix pass aborts", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn", meta_kind_strict: true }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(
      join(dir, "design-system/atoms/button.tsx"),
      `export function Button() { return <button />; }\n`,
    );
    await chmod(join(dir, "design-system/atoms"), 0o555);

    const r = await runCli(["audit", "--fix"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/rolled back/i);
    // Should NOT contain re-validation output
    expect(r.stdout).not.toMatch(/re-validation/i);

    await chmod(join(dir, "design-system/atoms"), 0o755);
  });

  it("includes re-validation findings in the scorecard", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ packVersion: "v0.9.0", pack: "next-react", mode: "warn", meta_kind_strict: true }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    // Same fixture as the test above — confident composite verdict + missing
    // meta.kind triggers an in-place fix whose re-validation surfaces new
    // findings (PRD #241 / #244).
    await writeFile(
      join(dir, "design-system/atoms/card.tsx"),
      `import { Icon } from "design-system/atoms/icon";\nimport { Button } from "design-system/atoms/button";\nimport { Badge } from "design-system/atoms/badge";\nexport function Card() { return <div><Icon /><Button /><Badge /></div>; }\n`,
    );
    const r = await runCli(["audit", "--fix"], { cwd: dir });
    // Scorecard should show errors from re-validation
    expect(r.stdout).toMatch(/Errors:\s*\d+/);
  });
});
