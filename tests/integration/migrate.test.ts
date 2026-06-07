import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/runcli";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { showcaseStub, toPascalCase } from "../../src/lib/ops/backfill-companions";
import { join } from "node:path";

async function adopted(dir: string) {
  await mkdir(join(dir, "design-system/atoms"), { recursive: true });
  await mkdir(join(dir, "design-system/composites"), { recursive: true });
  await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({ version:"v0.0.0", pack:"next-react", mode:"warn" }));
  await writeFile(join(dir, "design-system/exceptions.json"), JSON.stringify({ exceptions: [] }));
}

describe("migrate", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); await adopted(dir); });
  afterEach(async () => { await cleanup(dir); });

  it("moves a no-import component to atoms/", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    await writeFile(join(dir, "src/components/button.tsx"), `export const Button = () => null;`);
    const r = await runCli(["migrate", "src/components/button.tsx", "--reason", "ok", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    await stat(join(dir, "design-system/atoms/button.tsx"));
  });

  it("places a composite-importing source in composites/ (no longer a tier violation, #220)", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    await writeFile(join(dir, "src/components/panel.tsx"), `import { Card } from "@/design-system/composites/card";\nexport const Panel = () => null;`);
    const r = await runCli(["migrate", "src/components/panel.tsx", "--reason", "ok", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    await stat(join(dir, "design-system/composites/panel.tsx"));
  });

  it("rejects a feature-tier source with a pointer to classify (#220)", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    await writeFile(join(dir, "src/components/dash.tsx"), `import { foo } from "@/features/dash/data";\nexport const Dash = () => null;`);
    const r = await runCli(["migrate", "src/components/dash.tsx", "--reason", "x", "--yes"], { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/classifies as feature/);
    expect(r.stderr).toMatch(/claude-ds classify/);
  });

  it("rejects a pattern-tier source with a pointer to classify (#220)", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    await writeFile(join(dir, "src/components/slot.tsx"), `export const Slot = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;`);
    const r = await runCli(["migrate", "src/components/slot.tsx", "--reason", "x", "--yes"], { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/classifies as pattern/);
    expect(r.stderr).toMatch(/claude-ds classify/);
  });

  it("rejects an unknown-tier source (imports a pattern) with a pointer to classify (#220)", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    await writeFile(join(dir, "src/components/uses-pattern.tsx"), `import { List } from "@/design-system/patterns/list";\nexport const UsesPattern = () => null;`);
    const r = await runCli(["migrate", "src/components/uses-pattern.tsx", "--reason", "x", "--yes"], { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/classifies as unknown/);
    expect(r.stderr).toMatch(/claude-ds classify/);
  });

  it("honors --tier override, bypassing classification (#220)", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    // Source would classify as feature, but --tier forces composite — that's a real
    // post-migration DRIFT-MISPLACED, so --issue is required (#361).
    await writeFile(join(dir, "src/components/forced.tsx"), `import { foo } from "@/features/dash/data";\nexport const Forced = () => null;`);
    const r = await runCli(
      ["migrate", "src/components/forced.tsx", "--tier", "composite", "--reason", "ok", "--issue", "#1", "--yes"],
      { cwd: dir },
    );
    expect(r.code).toBe(0);
    await stat(join(dir, "design-system/composites/forced.tsx"));
  });

  it("seeds the canonical mirror-shaped showcase stub (#369) and points the operator at it", async () => {
    // The pre-#369 stub was `export default function Showcase(){ return null; }` with no
    // import of the migrated component and no `→ Next:` breadcrumb. The fix routes
    // through the same `showcaseStub` helper backfillCompanions uses so the seeded
    // file matches the canonical mirror form (TODO marker + module import + namespaced
    // default export) and the operator sees a Next breadcrumb naming the file to fill.
    await mkdir(join(dir, "src/components"), { recursive: true });
    await writeFile(join(dir, "src/components/lonely.tsx"), `export const Lonely = () => null;`);

    const r = await runCli(["migrate", "src/components/lonely.tsx", "--reason", "ok", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);

    const showcasePath = "design-system/atoms/lonely.showcase.tsx";
    const bytes = await readFile(join(dir, showcasePath), "utf8");
    expect(bytes).toBe(showcaseStub(toPascalCase("lonely"), "lonely"));

    // Sanity: TODO marker + import + named default export are all present.
    expect(bytes).toContain("TODO(claude-ds)");
    expect(bytes).toContain(`import * as Mod from "./lonely"`);
    expect(bytes).toContain("LonelyShowcase");

    // Operator-facing signal: a breadcrumb naming the file they need to fill.
    expect(r.stdout).toMatch(/→ Next:.*lonely\.showcase\.tsx/);
  });

  it("emits friendly error when source path does not exist (#360)", async () => {
    const r = await runCli(["migrate", "src/components/missing.tsx", "--reason", "t", "--yes"], { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/source not found: src\/components\/missing\.tsx/);
    expect(r.stderr).not.toMatch(/ENOENT/);
  });

  it("refuses on collision without --rename", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    await writeFile(join(dir, "src/components/button.tsx"), `export const Button = () => null;`);
    await writeFile(join(dir, "design-system/atoms/button.tsx"), `export const Button = () => null;`);
    const r = await runCli(["migrate", "src/components/button.tsx", "--reason","x","--yes"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/collision|exists/i);
  });

  it("does not register a DRIFT-MISPLACED exception for a correctly-placed file (#361)", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    await writeFile(join(dir, "src/components/lonely.tsx"), `export const Lonely = () => null;`);
    const r = await runCli(["migrate", "src/components/lonely.tsx", "--reason", "ok", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    await stat(join(dir, "design-system/atoms/lonely.tsx"));
    const raw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.exceptions).toEqual([]);
  });

  it("does not require --reason when no exception is needed (#361)", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    await writeFile(join(dir, "src/components/quiet.tsx"), `export const Quiet = () => null;`);
    const r = await runCli(["migrate", "src/components/quiet.tsx", "--yes"], { cwd: dir });
    expect(r.code).toBe(0);
    await stat(join(dir, "design-system/atoms/quiet.tsx"));
  });

  it("registers DRIFT-MISPLACED exception with --issue link when --tier forces a real misplacement (#361)", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    // No DS or domain imports → classifier says atom; --tier composite forces composites/ → real DRIFT-MISPLACED would fire.
    await writeFile(join(dir, "src/components/forced-atom.tsx"), `export const ForcedAtom = () => null;`);
    const r = await runCli(
      ["migrate", "src/components/forced-atom.tsx", "--tier", "composite", "--reason", "app shell singleton", "--issue", "#999", "--yes"],
      { cwd: dir },
    );
    expect(r.code).toBe(0);
    await stat(join(dir, "design-system/composites/forced-atom.tsx"));
    const raw = await readFile(join(dir, "design-system/exceptions.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.exceptions).toHaveLength(1);
    expect(parsed.exceptions[0].rule).toBe("DRIFT-MISPLACED");
    expect(parsed.exceptions[0].path).toBe("design-system/composites/forced-atom.tsx");
    expect(parsed.exceptions[0].issue).toBe("#999");
    expect(parsed.exceptions[0].reason).toBe("app shell singleton");
  });

  it("refuses --tier override that creates a misplacement without --issue (#361)", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    await writeFile(join(dir, "src/components/forced-atom.tsx"), `export const ForcedAtom = () => null;`);
    const r = await runCli(
      ["migrate", "src/components/forced-atom.tsx", "--tier", "composite", "--reason", "x", "--yes"],
      { cwd: dir },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--issue/);
  });
});
