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

  it("prints audit with-findings breadcrumb", () => {
    printNextStep("audit", { hasFindings: true });
    expect(logged.some(l => l.includes("claude-ds audit --fix"))).toBe(true);
  });

  it("routes audit breadcrumb to classify when extraction-needed findings remain", () => {
    printNextStep("audit", { hasFindings: true, extractionCount: 2 });
    const line = logged.find(l => l.includes("→ Next:"))!;
    expect(line).toContain("claude-ds classify");
    expect(line).toContain("2 inline components");
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
    expect(logged.some(l => l.includes("claude-ds audit --fix"))).toBe(true);
    expect(logged.some(l => l.includes("claude-ds classify"))).toBe(false);
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

  it("does not print breadcrumb for doctor", () => {
    printNextStep("doctor", {});
    expect(logged.length).toBe(0);
  });
});
