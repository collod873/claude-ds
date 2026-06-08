import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printNextStep, detectBuildCommand } from "../../src/lib/log.js";

describe("detectBuildCommand", () => {
  it("returns 'npm run build' when package.json has a build script", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { freshTmpDir, cleanup } = await import("../helpers/tmpdir.js");
    const dir = await freshTmpDir();
    try {
      await writeFile(`${dir}/package.json`, JSON.stringify({ scripts: { build: "next build" } }));
      expect(await detectBuildCommand(dir)).toBe("npm run build");
    } finally {
      await cleanup(dir);
    }
  });

  it("returns 'npx tsc' when package.json has no build script but has typescript dep", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { freshTmpDir, cleanup } = await import("../helpers/tmpdir.js");
    const dir = await freshTmpDir();
    try {
      await writeFile(`${dir}/package.json`, JSON.stringify({ devDependencies: { typescript: "^5" } }));
      expect(await detectBuildCommand(dir)).toBe("npx tsc");
    } finally {
      await cleanup(dir);
    }
  });

  it("returns generic message when no package.json exists", async () => {
    const { freshTmpDir, cleanup } = await import("../helpers/tmpdir.js");
    const dir = await freshTmpDir();
    try {
      expect(await detectBuildCommand(dir)).toBe("your build (e.g. npm run build)");
    } finally {
      await cleanup(dir);
    }
  });
});

describe("printNextStep", () => {
  let logged: string[];
  const origLog = console.log;

  beforeEach(() => {
    logged = [];
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  });
  afterEach(() => { console.log = origLog; });

  it("prints adopt breadcrumb", () => {
    printNextStep("adopt", {});
    expect(logged.some(l => l.includes("→ Next:"))).toBe(true);
    expect(logged.some(l => l.includes("claude-ds classify"))).toBe(true);
  });

  it("prints classify breadcrumb", () => {
    printNextStep("classify", {});
    expect(logged.some(l => l.includes("claude-ds audit"))).toBe(true);
  });

  it("prints audit no-findings breadcrumb with build command", () => {
    printNextStep("audit", { hasFindings: false, buildCmd: "npm run build" });
    expect(logged.some(l => l.includes("npm run build"))).toBe(true);
  });

  // C2 (#414): with-findings / extraction / unfixable / warnings breadcrumbs
  // route at `heal` — the single self-converging entry — not the bare loop
  // steps (`audit --fix`, `classify`) heal already runs itself.
  it("prints audit with-findings breadcrumb routing to heal", () => {
    printNextStep("audit", { hasFindings: true });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("claude-ds heal");
    expect(line).not.toContain("claude-ds audit --fix");
  });

  it("routes audit breadcrumb to heal when extraction-needed findings remain (C2)", () => {
    printNextStep("audit", { hasFindings: true, extractionCount: 2 });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("claude-ds heal");
    expect(line).toContain("2 inline components");
    expect(line).not.toContain("claude-ds classify");
    expect(line).not.toContain("claude-ds audit --fix");
  });

  it("singularizes the extraction breadcrumb for a single component", () => {
    printNextStep("audit", { hasFindings: true, extractionCount: 1 });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("1 inline component");
    expect(line).not.toContain("inline components");
  });

  it("keeps the default with-findings breadcrumb when extractionCount is 0", () => {
    printNextStep("audit", { hasFindings: true, extractionCount: 0 });
    expect(logged.some(l => l.includes("claude-ds heal"))).toBe(true);
    expect(logged.some(l => l.includes("claude-ds classify"))).toBe(false);
  });

  it("routes audit breadcrumb to heal when remaining findings are not auto-fixable (C2)", () => {
    printNextStep("audit", { hasFindings: true, unfixableCount: 3 });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("claude-ds heal");
    expect(line).not.toContain("claude-ds classify");
    expect(line).not.toContain("claude-ds audit --fix");
  });

  it("prefers the extraction breadcrumb when both extraction and other unfixable findings remain", () => {
    printNextStep("audit", { hasFindings: true, extractionCount: 2, unfixableCount: 3 });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("claude-ds heal");
    expect(line).toContain("2 inline components");
    expect(line).not.toContain("claude-ds classify");
  });

  it("keeps the default with-findings breadcrumb when unfixableCount is 0", () => {
    printNextStep("audit", { hasFindings: true, unfixableCount: 0 });
    expect(logged.some(l => l.includes("claude-ds heal"))).toBe(true);
    expect(logged.some(l => l.includes("claude-ds classify"))).toBe(false);
  });

  it("routes sync breadcrumb to heal on a brownfield tree (C2)", () => {
    printNextStep("sync", { brownfield: true });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("claude-ds heal");
    expect(line).not.toContain("claude-ds classify");
  });

  it("sync breadcrumb stays on audit when the tree is greenfield", () => {
    printNextStep("sync", { brownfield: false });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("claude-ds audit");
    expect(line).not.toContain("claude-ds classify");
  });

  it("prints audit-fix breadcrumb with build command", () => {
    printNextStep("audit-fix", { buildCmd: "npm run build" });
    expect(logged.some(l => l.includes("npm run build"))).toBe(true);
  });

  it("prints sync breadcrumb", () => {
    printNextStep("sync", {});
    expect(logged.some(l => l.includes("claude-ds audit"))).toBe(true);
  });

  it("prints reconcile breadcrumb", () => {
    printNextStep("reconcile", {});
    expect(logged.some(l => l.includes("claude-ds audit"))).toBe(true);
  });

  it("prints a breadcrumb for doctor (#349 F21 — CONTEXT.md mandates every command end with a → Next)", () => {
    printNextStep("doctor", {});
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.some(l => l.includes("→ Next:"))).toBe(true);
  });

  it("routes doctor's → Next at adopt when pre-adopt is the verdict (#349 F9/F21)", () => {
    printNextStep("doctor", { doctorVerdict: "pre-adopt" });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("claude-ds adopt");
  });

  // C2 (#414): every fixable doctor verdict reroutes at `heal`, not the bare
  // loop step (`sync`, `upgrade`, `audit --fix`, `migrate-layout`). The
  // operator no longer has to pick which command runs which loop member.
  it("routes doctor's → Next at heal when scaffold-gap is the verdict (C2)", () => {
    printNextStep("doctor", { doctorVerdict: "scaffold-gap" });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("claude-ds heal");
    expect(line).not.toMatch(/claude-ds sync\b/);
  });

  it("routes doctor's → Next at heal when repair-needed is the verdict (C2)", () => {
    printNextStep("doctor", { doctorVerdict: "repair-needed" });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("claude-ds heal");
    expect(line).not.toMatch(/claude-ds upgrade\b/);
  });

  it("routes doctor's → Next at heal when upgrade-available is the verdict (C2)", () => {
    printNextStep("doctor", { doctorVerdict: "upgrade-available" });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("claude-ds heal");
    expect(line).not.toMatch(/claude-ds upgrade\b/);
  });

  it("routes upgrade's → Next at audit when applied is the outcome", () => {
    printNextStep("upgrade", { upgradeOutcome: "applied" });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("claude-ds audit");
  });

  it("routes upgrade's → Next at audit when no-op is the outcome", () => {
    printNextStep("upgrade", { upgradeOutcome: "no-op" });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("claude-ds audit");
  });

  it("routes audit's → Next at heal when actionable warnings remain (#349 F9 / C2)", () => {
    printNextStep("audit", { hasActionableWarnings: true });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("claude-ds heal");
    expect(line).not.toContain("claude-ds audit --fix");
  });
});
