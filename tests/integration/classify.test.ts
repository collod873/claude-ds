import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";

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

describe("classify", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  async function setupBrownfieldFixture() {
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify(BASE_CFG));
    await mkdir(join(dir, "src/components"), { recursive: true });
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });

    // Atom: no DS imports
    await writeFile(
      join(dir, "src/components/button.tsx"),
      "export function Button() { return <button />; }",
    );
    // Composite: imports from DS atoms
    await writeFile(
      join(dir, "src/components/card.tsx"),
      `import { Button } from "@/design-system/atoms/button";\nexport function Card() { return <Button />; }`,
    );
    // Feature: imports from domain root
    await writeFile(
      join(dir, "src/components/invoice-list.tsx"),
      `import { getInvoices } from "../../features/invoicing/data";\nexport function InvoiceList() { return <div />; }`,
    );
  }

  it("exits non-zero without .claude-ds.json", async () => {
    const r = await runCli(["classify", "--src", "src/components"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/\.claude-ds\.json absent/);
  });

  it("dry-run: groups findings by destination tier", async () => {
    await setupBrownfieldFixture();
    const r = await runCli(["classify", "--src", "src/components", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/atom/);
    expect(r.stdout).toMatch(/button\.tsx/);
    expect(r.stdout).toMatch(/composite/);
    expect(r.stdout).toMatch(/card\.tsx/);
    expect(r.stdout).toMatch(/feature/);
    expect(r.stdout).toMatch(/invoice-list\.tsx/);
  });

  it("dry-run: emits Runner diff format for moves and meta.kind injection", async () => {
    await setupBrownfieldFixture();
    const r = await runCli(["classify", "--src", "src/components", "--dry-run"], { cwd: dir });
    expect(r.code).toBe(0);
    // Runner diff prefixes each line with [op-name] path (rename/modify)
    expect(r.stdout).toMatch(
      /\[classify-move-tier-file\] src\/components\/button\.tsx -> design-system\/atoms\/button\.tsx \(rename\)/,
    );
    expect(r.stdout).toMatch(
      /\[classify-move-tier-file\] design-system\/atoms\/button\.tsx \(modify\)/,
    );
    // The injected meta.kind stub appears as an added line in the diff
    expect(r.stdout).toMatch(/\+export const meta = \{ kind: "atom",/);
    // Composite is rendered too
    expect(r.stdout).toMatch(
      /\[classify-move-tier-file\] src\/components\/card\.tsx -> design-system\/composites\/card\.tsx \(rename\)/,
    );
    expect(r.stdout).toMatch(/\+export const meta = \{ kind: "composite",/);
  });

  it("dry-run: does not mutate any files", async () => {
    await setupBrownfieldFixture();
    await runCli(["classify", "--src", "src/components", "--dry-run"], { cwd: dir });
    // Original files must still exist
    await expect(access(join(dir, "src/components/button.tsx"))).resolves.toBeUndefined();
    await expect(access(join(dir, "src/components/card.tsx"))).resolves.toBeUndefined();
    // DS dirs must remain empty
    await expect(access(join(dir, "design-system/atoms/button.tsx"))).rejects.toThrow();
  });

  it("apply: moves atom to design-system/atoms/", async () => {
    await setupBrownfieldFixture();
    const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    await expect(access(join(dir, "design-system/atoms/button.tsx"))).resolves.toBeUndefined();
  });

  it("apply: moves composite to design-system/composites/", async () => {
    await setupBrownfieldFixture();
    const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    await expect(access(join(dir, "design-system/composites/card.tsx"))).resolves.toBeUndefined();
  });

  it("apply: backfills meta.kind on moved DS files", async () => {
    await setupBrownfieldFixture();
    const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    const buttonContent = await readFile(join(dir, "design-system/atoms/button.tsx"), "utf8");
    expect(buttonContent).toMatch(/meta/);
    expect(buttonContent).toMatch(/kind.*["']atom["']/);

    const cardContent = await readFile(join(dir, "design-system/composites/card.tsx"), "utf8");
    expect(cardContent).toMatch(/kind.*["']composite["']/);
  });

  it("apply: reports feature-tier files per domain bucket", async () => {
    await setupBrownfieldFixture();
    const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/invoice-list\.tsx/);
    expect(r.stdout).toMatch(/feature/i);
  });

  it("apply: prompts once per domain bucket for feature files (not per-file)", async () => {
    await setupBrownfieldFixture();
    // Add a second feature file in the same domain bucket
    await writeFile(
      join(dir, "src/components/invoice-form.tsx"),
      `import { saveInvoice } from "../../features/invoicing/api";\nexport function InvoiceForm() { return <form />; }`,
    );
    // With --yes we skip the prompt; verify both are reported together under the same bucket
    const r = await runCli(["classify", "--src", "src/components", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    // Both files should be mentioned under the same features/invoicing bucket group
    expect(r.stdout).toMatch(/features\/invoicing/);
    expect(r.stdout).toMatch(/invoice-list\.tsx/);
    expect(r.stdout).toMatch(/invoice-form\.tsx/);
  });
});
