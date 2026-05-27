import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";

function runHook(script: string, file: string) {
  const absFile = resolve("packs/next-react/tests/fixtures", file);
  const input = JSON.stringify({ tool_name: "Write", tool_input: { file_path: absFile } });
  const r = spawnSync("bash", [resolve("packs/next-react/files/.claude/hooks", script)], { encoding: "utf8", input });
  return { code: r.status ?? 1, stderr: r.stderr };
}

describe("next-react hooks (fixture)", () => {
  it("atom-imports: blocks composite-importing atom", () => {
    const r = runHook("atom-imports.sh", "atoms-bad/atom.tsx");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/atom-imports/);
  });
  it("atom-imports: allows clean atom", () => {
    const r = runHook("atom-imports.sh", "atoms-ok/atom.tsx");
    expect(r.code).toBe(0);
  });
  it("pre-write-ds-tokens: blocks raw hex color in design-system file (TOK-001)", () => {
    const r = runHook("pre-write-ds-tokens.sh", "ds-tokens-bad/design-system/atoms/atom.tsx");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/TOK-001/);
  });
  it("pre-write-ds-tokens: allows token-only design-system file", () => {
    const r = runHook("pre-write-ds-tokens.sh", "ds-tokens-ok/design-system/atoms/atom.tsx");
    expect(r.code).toBe(0);
  });

  // MAN-* tests
  it("pre-write-ds-manifest: blocks hand-edit of design-system/manifest.json", () => {
    const r = runHook("pre-write-ds-manifest.sh", "manifest-bad/design-system/manifest.json");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^[^:]+:\d+: [A-Z]+-\d+: /);
  });
  it("pre-write-ds-manifest: allows non-manifest files", () => {
    const r = runHook("pre-write-ds-manifest.sh", "manifest-ok/design-system/contracts.md");
    expect(r.code).toBe(0);
  });

  // TSX-* tests (Tier A scope-gate — AESTH-001/002/003 enforcement)
  it("pre-write-tsx: allows clean .tsx outside design-system/ (no violations)", () => {
    const r = runHook("pre-write-tsx.sh", "tsx-app-scope/MyComponent.tsx");
    expect(r.code).toBe(0);
  });
  it("pre-write-tsx: skips .tsx under design-system/ (out-of-scope, exits 0)", () => {
    const r = runHook("pre-write-tsx.sh", "tsx-ds-scope-skip/design-system/atoms/Button.tsx");
    expect(r.code).toBe(0);
  });

  // EXC-* tests
  it("pre-write-ds-exceptions: allows valid exceptions.json", () => {
    const r = runHook("pre-write-ds-exceptions.sh", "exceptions-ok/design-system/exceptions.json");
    expect(r.code).toBe(0);
  });
  it("pre-write-ds-exceptions: blocks exceptions.json missing reason (EXC-001)", () => {
    const r = runHook("pre-write-ds-exceptions.sh", "exceptions-bad-missing-reason/design-system/exceptions.json");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^[^:]+:\d+: EXC-001: /);
  });

  // TIER-* tests
  it("pre-write-ds-tier-imports: allows clean atom with no forbidden imports", () => {
    const r = runHook("pre-write-ds-tier-imports.sh", "tier-imports-ok-atom/design-system/atoms/Label.tsx");
    expect(r.code).toBe(0);
  });
  it("pre-write-ds-tier-imports: blocks atom importing from composites/ (TIER-001)", () => {
    const r = runHook("pre-write-ds-tier-imports.sh", "tier-imports-bad-atom/design-system/atoms/BadAtom.tsx");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^[^:]+:\d+: TIER-001: /);
  });

  // COMMIT-* tests
  it("pre-commit-global: skips non-git-commit bash commands (exit 0)", () => {
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm run build" } });
    const r = spawnSync(
      "bash",
      [resolve("packs/next-react/files/.claude/hooks", "pre-commit-global.sh")],
      { encoding: "utf8", input }
    );
    expect(r.status).toBe(0);
  });
  it("pre-commit-global: exits 1 with COMMIT-000 when commitlint not in PATH", () => {
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git commit -m 'test'" } });
    const r = spawnSync(
      "bash",
      [resolve("packs/next-react/files/.claude/hooks", "pre-commit-global.sh")],
      { encoding: "utf8", input, env: { ...process.env, PATH: "/bin:/usr/bin" } }
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/COMMIT-000/);
  });

  // SIM-* tests — un-skipped after Slice F added similarity-check.ts.
  // The hook checks for scripts/similarity-check.ts relative to cwd.
  // In an adopted project, scripts/ lives at project root. In this fixture
  // harness, we run with cwd=packs/next-react/files/ which contains scripts/.
  it("pre-write-ds-similarity: exits 1 self-error with SIM-000 when scripts/ not in cwd", () => {
    // runHook() uses default cwd (repo root) — no scripts/ there.
    const r = runHook("pre-write-ds-similarity.sh", "states-ok/design-system/atoms/Button.tsx");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/SIM-000/);
  });
  it("pre-write-ds-similarity: exits 0 for files outside design-system/ even when near-duplicates exist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sim-hook-outside-"));
    try {
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      mkdirSync(join(tmp, "design-system", "atoms"), { recursive: true });
      copyFileSync(
        resolve("packs/next-react/files/scripts/similarity-check.ts"),
        join(tmp, "scripts", "similarity-check.ts")
      );
      // Near-duplicate atoms that would trigger SIM-001 if the scan runs
      writeFileSync(join(tmp, "design-system", "atoms", "Button.tsx"), "");
      writeFileSync(join(tmp, "design-system", "atoms", "Buton.tsx"), "");
      // Target is outside design-system/ — hook should early-exit without scanning
      const targetFile = join(tmp, "src", "components", "Foo.tsx");
      const input = JSON.stringify({ tool_name: "Write", tool_input: { file_path: targetFile } });
      const r = spawnSync(
        "bash",
        [resolve("packs/next-react/files/.claude/hooks/pre-write-ds-similarity.sh")],
        { encoding: "utf8", cwd: tmp, input }
      );
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("pre-write-ds-similarity: exits 0 when similarity-check.ts present and no near-duplicates found", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sim-hook-"));
    try {
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      mkdirSync(join(tmp, "design-system", "atoms"), { recursive: true });
      copyFileSync(
        resolve("packs/next-react/files/scripts/similarity-check.ts"),
        join(tmp, "scripts", "similarity-check.ts")
      );
      const targetFile = join(tmp, "design-system", "atoms", "Button.tsx");
      writeFileSync(targetFile, "");
      const input = JSON.stringify({ tool_name: "Write", tool_input: { file_path: targetFile } });
      const r = spawnSync(
        "bash",
        [resolve("packs/next-react/files/.claude/hooks/pre-write-ds-similarity.sh")],
        { encoding: "utf8", cwd: tmp, input }
      );
      expect(r.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("hook stdin contract", () => {
  it("hooks exit 0 gracefully when invoked with no stdin and no args", () => {
    const hooks = [
      "pre-write-tsx.sh",
      "pre-write-ds-manifest.sh",
      "pre-write-ds-exceptions.sh",
      "pre-write-ds-tokens.sh",
      "pre-write-ds-tier-imports.sh",
      "pre-write-ds-similarity.sh",
      "regenerate-companions.sh",
      "atom-imports.sh",
    ];
    for (const hook of hooks) {
      const r = spawnSync("bash", [resolve("packs/next-react/files/.claude/hooks", hook)], {
        encoding: "utf8",
        input: "",
      });
      expect(r.status, `${hook} should exit 0 with no input`).toBe(0);
    }
  });

  it("pre-commit-global: exits 0 when invoked with no stdin and no args", () => {
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "" } });
    const r = spawnSync("bash", [resolve("packs/next-react/files/.claude/hooks", "pre-commit-global.sh")], {
      encoding: "utf8",
      input,
    });
    expect(r.status).toBe(0);
  });

  it("hooks exit 1 with actionable error when jq is missing and stdin JSON is provided", () => {
    // Build a minimal PATH that has bash/cat/grep but not jq
    const binDir = mkdtempSync(join(tmpdir(), "no-jq-"));
    try {
      for (const bin of ["bash", "cat", "grep", "sed", "dirname", "printf"]) {
        const real = spawnSync("which", [bin], { encoding: "utf8" }).stdout.trim();
        if (real) {
          symlinkSync(real, join(binDir, bin));
        }
      }
      const input = JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/tmp/test.tsx" } });
      const r = spawnSync(
        "bash",
        [resolve("packs/next-react/files/.claude/hooks", "atom-imports.sh")],
        {
          encoding: "utf8",
          input,
          env: { ...process.env, PATH: binDir },
        }
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/jq/i);
      expect(r.stderr).toMatch(/install/i);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("hooks work with paths containing spaces", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hook-spaces-test-"));
    try {
      const dir = join(tmp, "My Project", "design-system", "atoms");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "Button.tsx");
      writeFileSync(file, "export const Button = () => <button>click</button>;\n");
      const input = JSON.stringify({ tool_name: "Write", tool_input: { file_path: file } });
      const r = spawnSync("bash", [resolve("packs/next-react/files/.claude/hooks", "pre-write-ds-tokens.sh")], {
        encoding: "utf8",
        input,
      });
      expect(r.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
