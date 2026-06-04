import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { classifyCmd } from "../../src/commands/classify";
import type { FixerPrompt } from "../../src/lib/drift/index.js";

// PRD #241 / sub-issue #243 — story 9: every tier move must rewrite ALL
// importers across the consumer tree, including app code that imports via
// `@ds/*` or `@/` aliases. Any dangling importer after a move is the exact
// bug behind the 14 broken imports in the HITL run; this test guards against
// the regression.
const BASE_CFG = {
  packVersion: "v0.9.0",
  pack: "next-react",
  mode: "warn",
  domain_roots: ["features", "lib"],
};

describe("classify rewrites all importers on a tier move (story 9)", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await freshTmpDir();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await cleanup(dir);
  });

  it("rewrites @ds/atoms/<name> importers across src/ after an atom→composite move", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, ds_aliases: ["@ds"] }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await mkdir(join(dir, "src/app"), { recursive: true });
    // --src must exist (the re-run path: classify came back to resolve an
    // ambiguity, nothing new to pull in).
    await mkdir(join(dir, "src/components"), { recursive: true });

    // Three plain atoms the combo will import.
    for (const name of ["button", "input", "badge"]) {
      const Name = name[0].toUpperCase() + name.slice(1);
      await writeFile(
        join(dir, `design-system/atoms/${name}.tsx`),
        `export function ${Name}() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      );
    }

    // combo.tsx — lives in atoms/ but composes 3 DS components → ambiguity
    // prompt fires and (with prompt answer = "move") classify relocates it.
    await writeFile(
      join(dir, "design-system/atoms/combo.tsx"),
      [
        `import { Button } from "@ds/atoms/button";`,
        `import { Input } from "@ds/atoms/input";`,
        `import { Badge } from "@ds/atoms/badge";`,
        `export function Combo() { return <div><Button/><Input/><Badge/></div>; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
        "",
      ].join("\n"),
    );

    // Consumer app code references the DS file via @ds/atoms/combo — this is
    // the importer that must not be left dangling after the move.
    await writeFile(
      join(dir, "src/app/page.tsx"),
      `import { Combo } from "@ds/atoms/combo";\nexport default function Page() { return <Combo/>; }\n`,
    );

    const prompt: FixerPrompt = async () => 1; // "Move to composites"
    await classifyCmd({ src: "src/components", cwd: dir, prompt });

    // The file moved.
    await expect(access(join(dir, "design-system/atoms/combo.tsx"))).rejects.toThrow();
    await expect(access(join(dir, "design-system/composites/combo.tsx"))).resolves.toBeUndefined();

    // Every importer rewritten — no dangling @ds/atoms/combo anywhere.
    const pageAfter = await readFile(join(dir, "src/app/page.tsx"), "utf8");
    expect(pageAfter).toContain(`from "@ds/composites/combo"`);
    expect(pageAfter).not.toContain(`from "@ds/atoms/combo"`);
  });

  it("rewrites @/design-system AND @ds importers in the same project after a tier move", async () => {
    await writeFile(
      join(dir, ".claude-ds.json"),
      JSON.stringify({ ...BASE_CFG, ds_aliases: ["@ds"] }),
    );
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await mkdir(join(dir, "src/app"), { recursive: true });
    await mkdir(join(dir, "src/features/dashboard"), { recursive: true });
    await mkdir(join(dir, "src/components"), { recursive: true });

    for (const name of ["button", "input", "badge"]) {
      const Name = name[0].toUpperCase() + name.slice(1);
      await writeFile(
        join(dir, `design-system/atoms/${name}.tsx`),
        `export function ${Name}() { return <span/>; }\nexport const meta = { kind: "atom" as const, examples: [] };\n`,
      );
    }
    await writeFile(
      join(dir, "design-system/atoms/combo.tsx"),
      [
        `import { Button } from "@ds/atoms/button";`,
        `import { Input } from "@ds/atoms/input";`,
        `import { Badge } from "@ds/atoms/badge";`,
        `export function Combo() { return <div><Button/><Input/><Badge/></div>; }`,
        `export const meta = { kind: "atom" as const, examples: [] };`,
        "",
      ].join("\n"),
    );

    // Mixed alias forms in different consumer files — both must be rewritten.
    await writeFile(
      join(dir, "src/app/page.tsx"),
      `import { Combo } from "@ds/atoms/combo";\nexport default function Page() { return <Combo/>; }\n`,
    );
    await writeFile(
      join(dir, "src/features/dashboard/widget.tsx"),
      `import { Combo } from "@/design-system/atoms/combo";\nexport function Widget() { return <Combo/>; }\n`,
    );

    const prompt: FixerPrompt = async () => 1;
    await classifyCmd({ src: "src/components", cwd: dir, prompt });

    const pageAfter = await readFile(join(dir, "src/app/page.tsx"), "utf8");
    expect(pageAfter).toContain(`from "@ds/composites/combo"`);
    expect(pageAfter).not.toContain(`from "@ds/atoms/combo"`);

    const widgetAfter = await readFile(join(dir, "src/features/dashboard/widget.tsx"), "utf8");
    expect(widgetAfter).toContain(`from "@/design-system/composites/combo"`);
    expect(widgetAfter).not.toContain(`from "@/design-system/atoms/combo"`);
  });
});
