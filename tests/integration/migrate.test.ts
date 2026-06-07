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
    // Source would classify as feature, but --tier forces composite.
    await writeFile(join(dir, "src/components/forced.tsx"), `import { foo } from "@/features/dash/data";\nexport const Forced = () => null;`);
    const r = await runCli(["migrate", "src/components/forced.tsx", "--tier", "composite", "--reason", "ok", "--yes"], { cwd: dir });
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

  it("refuses on collision without --rename", async () => {
    await mkdir(join(dir, "src/components"), { recursive: true });
    await writeFile(join(dir, "src/components/button.tsx"), `export const Button = () => null;`);
    await writeFile(join(dir, "design-system/atoms/button.tsx"), `export const Button = () => null;`);
    const r = await runCli(["migrate", "src/components/button.tsx", "--reason","x","--yes"], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/collision|exists/i);
  });
});
