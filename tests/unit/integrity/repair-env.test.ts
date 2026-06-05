import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freshTmpDir, cleanup } from "../../helpers/tmpdir";
import { buildRepairEnv } from "../../../src/lib/integrity/repair-env";

async function write(dir: string, rel: string, content: string): Promise<void> {
  await mkdir(join(dir, rel, ".."), { recursive: true });
  await writeFile(join(dir, rel), content);
}

describe("buildRepairEnv — consumer import graph", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("resolves a symbol to the unique specifier already used elsewhere in the consumer", async () => {
    // A sibling file already imports Button from a specifier that resolves.
    await write(dir, "design-system/atoms/button.tsx", `export function Button() { return <button />; }\n`);
    await write(
      dir,
      "design-system/composites/toolbar.tsx",
      `import { Button } from "@/design-system/atoms/button";\nexport function Toolbar() { return <Button />; }\n`,
    );

    const env = await buildRepairEnv({ cwd: dir, fileName: "design-system/atoms/row.tsx" });

    expect(env.resolve("Button")).toEqual({
      specifier: "@/design-system/atoms/button",
      kind: "named",
    });
  });

  it("declines (null) when the same symbol is imported from two different specifiers — ambiguous", async () => {
    await write(dir, "src/a.tsx", `import { format } from "date-fns";\nexport const a = format;\n`);
    await write(dir, "src/b.tsx", `import { format } from "@/lib/format";\nexport const b = format;\n`);

    const env = await buildRepairEnv({ cwd: dir, fileName: "design-system/atoms/row.tsx" });

    expect(env.resolve("format")).toBeNull();
  });

  it("declines (null) for a symbol nothing imports — left for the finding to flag", async () => {
    await write(dir, "src/a.tsx", `export const a = 1;\n`);

    const env = await buildRepairEnv({ cwd: dir, fileName: "design-system/atoms/row.tsx" });

    expect(env.resolve("MysteryWidget")).toBeNull();
  });
});

describe("buildRepairEnv — sibling DS-tree resolver", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  async function writeTsconfig(paths: Record<string, string[]>): Promise<void> {
    await write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { paths } }));
  }

  it("resolves a DS-defined component to its canonical DS alias from tsconfig paths", async () => {
    await writeTsconfig({ "@ds/*": ["./design-system/*"] });
    await write(dir, "design-system/atoms/button.tsx", `export function Button() { return <button />; }\n`);

    const env = await buildRepairEnv({ cwd: dir, fileName: "design-system/atoms/row.tsx" });

    expect(env.resolve("Button")).toEqual({ specifier: "@ds/atoms/button", kind: "named" });
  });

  it("collapses two alias spellings of the same file to the dominant prefix (not ambiguous)", async () => {
    // Pure specifier-uniqueness would see two specifiers and decline; resolving
    // by DS-definition file identity collapses them to the canonical alias.
    await writeTsconfig({ "@ds/*": ["./design-system/*"], "@/design-system/*": ["./design-system/*"] });
    await write(dir, "design-system/atoms/button.tsx", `export function Button() { return <button />; }\n`);
    await write(dir, "design-system/composites/a.tsx", `import { Button } from "@ds/atoms/button";\nimport { Card } from "@ds/atoms/card";\nexport const A = () => <Button />;\n`);
    await write(dir, "design-system/composites/b.tsx", `import { Button } from "@/design-system/atoms/button";\nexport const B = () => <Button />;\n`);

    const env = await buildRepairEnv({ cwd: dir, fileName: "design-system/atoms/row.tsx" });

    // @ds is the more-used prefix → canonical.
    expect(env.resolve("Button")).toEqual({ specifier: "@ds/atoms/button", kind: "named" });
  });

  it("imports a symbol from its definition module, not a barrel or a re-exporting file", async () => {
    await writeTsconfig({ "@ds/*": ["./design-system/*"] });
    await write(dir, "design-system/atoms/tooltip-content.tsx", `export function TooltipContent() { return <div />; }\n`);
    // tooltip.tsx re-exports it; the atoms barrel forwards it. Neither is the definition.
    await write(dir, "design-system/atoms/tooltip.tsx", `export { TooltipContent } from "@ds/atoms/tooltip-content";\n`);
    await write(dir, "design-system/atoms/index.ts", `export { TooltipContent } from "@ds/atoms/tooltip-content";\n`);

    const env = await buildRepairEnv({ cwd: dir, fileName: "design-system/atoms/nav-row.tsx" });

    expect(env.resolve("TooltipContent")).toEqual({
      specifier: "@ds/atoms/tooltip-content",
      kind: "named",
    });
  });

  it("resolves a locally-declared symbol exported via a trailing export list (the shadcn idiom)", async () => {
    await writeTsconfig({ "@ds/*": ["./design-system/*"] });
    // `function Tooltip(){}` … `export { Tooltip, TooltipTrigger }` — no export modifier on the decl.
    await write(
      dir,
      "design-system/atoms/tooltip.tsx",
      `import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";\n` +
        `function Tooltip(props: object) { return <TooltipPrimitive.Root {...props} />; }\n` +
        `function TooltipTrigger(props: object) { return <TooltipPrimitive.Trigger {...props} />; }\n` +
        `export { Tooltip, TooltipTrigger };\n`,
    );

    const env = await buildRepairEnv({ cwd: dir, fileName: "design-system/atoms/nav-row.tsx" });

    expect(env.resolve("Tooltip")).toEqual({ specifier: "@ds/atoms/tooltip", kind: "named" });
    expect(env.resolve("TooltipTrigger")).toEqual({ specifier: "@ds/atoms/tooltip", kind: "named" });
  });

  it("resolves via the sole DS file that re-exports a symbol it does not define (cn)", async () => {
    await writeTsconfig({ "@ds/*": ["./design-system/*"] });
    // cn is defined outside the DS tree; one DS file forwards it — the canonical DS specifier.
    await write(dir, "design-system/utils/utils.ts", `export { cn } from "@/lib/utils";\n`);
    await write(dir, "src/lib/utils.ts", `export function cn(...a: string[]) { return a.join(" "); }\n`);

    const env = await buildRepairEnv({ cwd: dir, fileName: "design-system/atoms/row.tsx" });

    expect(env.resolve("cn")).toEqual({ specifier: "@ds/utils/utils", kind: "named" });
  });

  it("prefers the defining module over a sibling that re-exports the same symbol", async () => {
    await writeTsconfig({ "@ds/*": ["./design-system/*"] });
    await write(dir, "design-system/atoms/tooltip-content.tsx", `export function TooltipContent() { return <div />; }\n`);
    // tooltip.tsx imports then re-exports it (a forward, not a definition).
    await write(
      dir,
      "design-system/atoms/tooltip.tsx",
      `import { TooltipContent } from "@ds/atoms/tooltip-content";\nexport { TooltipContent };\n`,
    );

    const env = await buildRepairEnv({ cwd: dir, fileName: "design-system/atoms/nav-row.tsx" });

    expect(env.resolve("TooltipContent")).toEqual({
      specifier: "@ds/atoms/tooltip-content",
      kind: "named",
    });
  });

  it("declines a parent-local helper that no DS file exports (the calendar-atom case)", async () => {
    await writeTsconfig({ "@ds/*": ["./design-system/*"] });
    // addDays is a module-private function inside the parent composite — never exported.
    await write(
      dir,
      "design-system/composites/calendar-view.tsx",
      `function addDays(d: Date, n: number) { return d; }\nexport function CalendarView() { return <div>{String(addDays(new Date(), 1))}</div>; }\n`,
    );

    const env = await buildRepairEnv({ cwd: dir, fileName: "design-system/atoms/month-grid.tsx" });

    expect(env.resolve("addDays")).toBeNull();
  });
});
