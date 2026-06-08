import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

describe("next-step breadcrumbs (#193)", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("adopt prints → Next: with classify", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds classify/);
  });

  it("classify prints → Next: with audit", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      packVersion: "v0.8.0", pack: "next-react", mode: "warn",
      app_dir: "app", claude_md_target: ".claude/CLAUDE.md",
    }));
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "src/components"), { recursive: true });
    const r = await runCli(["classify", "--src", "src/components"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds audit/);
  });

  it("audit (no findings) prints → Next: with build command", async () => {
    await mkdir(join(dir, "design-system"), { recursive: true });
    await writeFile(join(dir, "design-system/contracts.md"), "# contracts");
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*build/);
  });

  it("audit (with auto-fixable findings) prints → Next: with audit --fix", async () => {
    // A correctly-placed atom with the retired meta.states field (ADR-0007)
    // produces DRIFT-STALE-META-STATES — an auto-fixable rule. Breadcrumb
    // should still point at `audit --fix`, not classify (#245).
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(
      join(dir, "design-system/atoms/solo-label.tsx"),
      `export const meta = { kind: 'atom' as const, states: { loading: true } };
export function SoloLabel() { return <span />; }
`,
    );
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/DRIFT-STALE-META-STATES/);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds audit --fix/);
    expect(r.stdout).not.toMatch(/→ Next:.*claude-ds classify/);
  });

  it("audit --fix leaving an inline-component raw primitive points at classify (#207)", async () => {
    // A composite with a non-exported, ≥20-line inline component that renders a
    // raw <button>. The fixer can't replace it in place (extraction is classify's
    // job) and defers; the breadcrumb must route to classify, not audit --fix.
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    const inlineBody = Array.from({ length: 22 }, (_, i) => `    const v${i} = ${i};`).join("\n");
    await writeFile(
      join(dir, "design-system/composites/calendar-view.tsx"),
      `import { Card } from "@/design-system/atoms/card";
function DayCell() {
${inlineBody}
  return <button type="button">{v0}</button>;
}
export function CalendarView() {
  return <Card><DayCell /></Card>;
}
`,
    );
    const r = await runCli(["audit", "--pack", "next-react", "--fix"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds classify/);
    expect(r.stdout).toMatch(/inline component/);
    expect(r.stdout).not.toMatch(/→ Next:.*claude-ds audit --fix/);
  });

  it("audit (MISPLACED finding) points → Next: at classify, not audit --fix (#245)", async () => {
    // A composite-shaped file (≥3 DS-component imports) living under atoms/
    // produces DRIFT-MISPLACED. That finding is report-only — `audit --fix`
    // can't repair it, only `classify` can. Breadcrumb must reflect that.
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    for (const name of ["card", "button", "input"]) {
      await writeFile(
        join(dir, `design-system/atoms/${name}.tsx`),
        `export function ${name[0].toUpperCase()}${name.slice(1)}() { return <div />; }\n`,
      );
    }
    await writeFile(
      join(dir, "design-system/atoms/sidebar.tsx"),
      `import { Card } from "@/design-system/atoms/card";
import { Button } from "@/design-system/atoms/button";
import { Input } from "@/design-system/atoms/input";
export function Sidebar() { return <Card><Button /><Input /></Card>; }
`,
    );
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/DRIFT-MISPLACED/);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds classify/);
    expect(r.stdout).not.toMatch(/→ Next:.*claude-ds audit --fix/);
  });

  it("sync on a brownfield tree points → Next: at classify (#245)", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }),
    );
    // Pre-existing consumer tier file makes this tree brownfield: there is
    // something for classify to look at. Sync's Next: must route there, not
    // skip ahead to audit.
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await writeFile(
      join(dir, "design-system/atoms/legacy-button.tsx"),
      "export function LegacyButton() { return <button />; }\n",
    );
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds classify/);
    expect(r.stdout).not.toMatch(/→ Next:.*claude-ds audit\b/);
  });

  it("audit breadcrumb detects package.json build script", async () => {
    await mkdir(join(dir, "design-system"), { recursive: true });
    await writeFile(join(dir, "design-system/contracts.md"), "# contracts");
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { build: "next build" } }));
    const r = await runCli(["audit", "--pack", "next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*npm run build/);
  });

  it("sync prints → Next: with audit", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds audit/);
  });

  it("reconcile prints → Next: with audit", async () => {
    const adopt = await runCli(["adopt", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(adopt.code).toBe(0);
    const r = await runCli(["reconcile"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds audit/);
  });

  it("doctor prints → Next: (per #349 F21 — CONTEXT.md mandates every command end with a breadcrumb)", async () => {
    const r = await runCli(["doctor", "--pack", "next-react"], { cwd: dir });
    expect(r.stdout).toMatch(/→ Next:/);
  });

  it("adopt --dry-run does NOT print breadcrumb", async () => {
    const r = await runCli(["adopt", "--pack", "next-react", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/→ Next:/);
  });

  it("sync --dry-run does NOT print breadcrumb", async () => {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }));
    const r = await runCli(["sync", "--offline-fixture", "packs/next-react", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/→ Next:/);
  });

  // #363: five unexercised commands all skipped the breadcrumb on at least one
  // completion path. Tests below pin every path that should now end with → Next.

  it("version (default, offline, pinned == installed) prints → Next: with audit", async () => {
    const { default: pkg } = await import("../../package.json", { with: { type: "json" } });
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: `v${pkg.version}`, pack: "next-react", mode: "warn" }),
    );
    const r = await runCli(["version", "--offline"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds audit/);
  });

  it("version (default, offline, pinned < installed) routes → Next: to upgrade", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v0.1.0", pack: "next-react", mode: "warn" }),
    );
    const r = await runCli(["version", "--offline"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds upgrade/);
  });

  it("version (default, no .claude-ds.json) routes → Next: to adopt", async () => {
    const r = await runCli(["version", "--offline"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds adopt/);
  });

  it("version --check (up to date) prints → Next: with audit", async () => {
    const { default: pkg } = await import("../../package.json", { with: { type: "json" } });
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: `v${pkg.version}`, pack: "next-react", mode: "warn" }),
    );
    const r = await runCli(["version", "--check"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds audit/);
  });

  it("version --check (behind) prints → Next: with upgrade", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v0.1.0", pack: "next-react", mode: "warn" }),
    );
    const r = await runCli(["version", "--check"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds upgrade/);
  });

  it("version --check (no .claude-ds.json) routes → Next: to adopt", async () => {
    const r = await runCli(["version", "--check"], { cwd: dir });
    // Exits non-zero (no config to check), but still terminates with a breadcrumb.
    expect(r.code).not.toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).toMatch(/→ Next:.*claude-ds adopt/);
  });

  // #363: pin the `ahead` routing (pinned > installed) — the only branch with a
  // non-`run 'claude-ds X'` message ("update the CLI binary…"). Both surfaces
  // — default mode and --check — share the same switch, so cover both.
  it("version (default, offline, pinned > installed) routes → Next: to update the CLI binary", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v999.0.0", pack: "next-react", mode: "warn" }),
    );
    const r = await runCli(["version", "--offline"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*update the CLI binary/);
  });

  it("version --check (pinned > installed) routes → Next: to update the CLI binary", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v999.0.0", pack: "next-react", mode: "warn" }),
    );
    const r = await runCli(["version", "--check"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/→ Next:.*update the CLI binary/);
  });

  it("migrate-layout (nothing to migrate) prints → Next:", async () => {
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFile = promisify(execFileCb);
    await execFile("git", ["init"], { cwd: dir });
    await execFile("git", ["config", "user.email", "t@t"], { cwd: dir });
    await execFile("git", ["config", "user.name", "t"], { cwd: dir });
    await mkdir(join(dir, "design-system"), { recursive: true });
    await writeFile(join(dir, "design-system/tokens.json"), "{}");
    await writeFile(join(dir, "design-system/contracts.md"), "# contracts");
    await execFile("git", ["add", "design-system/tokens.json", "design-system/contracts.md"], { cwd: dir });
    await execFile("git", ["commit", "-m", "seed"], { cwd: dir });

    const r = await runCli(["migrate-layout", "--pack", "next-react", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/nothing to migrate/);
    expect(r.stdout).toMatch(/→ Next:/);
  });

  it("reconform prints → Next: with audit on apply", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }),
    );
    await writeFile(join(dir, "design-system/exceptions.json"), JSON.stringify({ exceptions: [] }));
    const r = await runCli(["reconform"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds audit/);
  });

  it("reconform --dry-run prints → Next:", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn" }),
    );
    await writeFile(join(dir, "design-system/exceptions.json"), JSON.stringify({ exceptions: [] }));
    const r = await runCli(["reconform", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/→ Next:/);
  });

  it("enforce (flipped warn→block) prints → Next: with audit", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "warn", enforce_threshold: 2 }),
    );
    await mkdir(join(dir, "design-system"), { recursive: true });
    await writeFile(join(dir, "design-system/exceptions.json"), JSON.stringify({ exceptions: [] }));
    const r = await runCli(["enforce", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/mode flipped to block/);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds audit/);
  });

  it("enforce (already in block mode) prints → Next: with audit", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ version: "v0.0.0", pack: "next-react", mode: "block", enforce_threshold: 2 }),
    );
    await mkdir(join(dir, "design-system"), { recursive: true });
    await writeFile(join(dir, "design-system/exceptions.json"), JSON.stringify({ exceptions: [] }));
    const r = await runCli(["enforce", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/already in block mode/i);
    expect(r.stdout).toMatch(/→ Next:.*claude-ds audit/);
  });
});
