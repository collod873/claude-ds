import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freshTmpDir, cleanup } from "../../helpers/tmpdir";
import { buildRepairEnv } from "../../../src/lib/integrity/repair-env";
import { resolveAuditConfig } from "../../../src/lib/audit-config";
import { makeFakeCtx } from "../../helpers/fake-ctx";

async function write(dir: string, rel: string, content: string): Promise<void> {
  await mkdir(join(dir, rel, ".."), { recursive: true });
  await writeFile(join(dir, rel), content);
}

/**
 * Mint a ctx for the fixture and call buildRepairEnv with it. `tsconfigPaths`
 * now flows through `ctx.auditConfig` (PRD #266 Phase B); resolving via the
 * production resolver here keeps fixture tsconfigs visible to the env.
 */
async function buildEnv(dir: string, fileName: string) {
  const auditConfig = await resolveAuditConfig(dir, null);
  const ctx = makeFakeCtx(dir, { auditConfig });
  return buildRepairEnv(ctx, fileName);
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

    const env = await buildEnv(dir, "design-system/atoms/row.tsx");

    expect(env.resolve("Button")).toEqual({
      specifier: "@/design-system/atoms/button",
      kind: "named",
    });
  });

  it("declines (null) when the same symbol is imported from two different specifiers — ambiguous", async () => {
    await write(dir, "src/a.tsx", `import { format } from "date-fns";\nexport const a = format;\n`);
    await write(dir, "src/b.tsx", `import { format } from "@/lib/format";\nexport const b = format;\n`);

    const env = await buildEnv(dir, "design-system/atoms/row.tsx");

    expect(env.resolve("format")).toBeNull();
  });

  it("declines (null) for a symbol nothing imports — left for the finding to flag", async () => {
    await write(dir, "src/a.tsx", `export const a = 1;\n`);

    const env = await buildEnv(dir, "design-system/atoms/row.tsx");

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

    const env = await buildEnv(dir, "design-system/atoms/row.tsx");

    expect(env.resolve("Button")).toEqual({ specifier: "@ds/atoms/button", kind: "named" });
  });

  it("collapses two alias spellings of the same file to the dominant prefix (not ambiguous)", async () => {
    // Pure specifier-uniqueness would see two specifiers and decline; resolving
    // by DS-definition file identity collapses them to the canonical alias.
    await writeTsconfig({ "@ds/*": ["./design-system/*"], "@/design-system/*": ["./design-system/*"] });
    await write(dir, "design-system/atoms/button.tsx", `export function Button() { return <button />; }\n`);
    await write(dir, "design-system/composites/a.tsx", `import { Button } from "@ds/atoms/button";\nimport { Card } from "@ds/atoms/card";\nexport const A = () => <Button />;\n`);
    await write(dir, "design-system/composites/b.tsx", `import { Button } from "@/design-system/atoms/button";\nexport const B = () => <Button />;\n`);

    const env = await buildEnv(dir, "design-system/atoms/row.tsx");

    // @ds is the more-used prefix → canonical.
    expect(env.resolve("Button")).toEqual({ specifier: "@ds/atoms/button", kind: "named" });
  });

  it("imports a symbol from its definition module, not a barrel or a re-exporting file", async () => {
    await writeTsconfig({ "@ds/*": ["./design-system/*"] });
    await write(dir, "design-system/atoms/tooltip-content.tsx", `export function TooltipContent() { return <div />; }\n`);
    // tooltip.tsx re-exports it; the atoms barrel forwards it. Neither is the definition.
    await write(dir, "design-system/atoms/tooltip.tsx", `export { TooltipContent } from "@ds/atoms/tooltip-content";\n`);
    await write(dir, "design-system/atoms/index.ts", `export { TooltipContent } from "@ds/atoms/tooltip-content";\n`);

    const env = await buildEnv(dir, "design-system/atoms/nav-row.tsx");

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

    const env = await buildEnv(dir, "design-system/atoms/nav-row.tsx");

    expect(env.resolve("Tooltip")).toEqual({ specifier: "@ds/atoms/tooltip", kind: "named" });
    expect(env.resolve("TooltipTrigger")).toEqual({ specifier: "@ds/atoms/tooltip", kind: "named" });
  });

  it("resolves via the sole DS file that re-exports a symbol it does not define (cn)", async () => {
    await writeTsconfig({ "@ds/*": ["./design-system/*"] });
    // cn is defined outside the DS tree; one DS file forwards it — the canonical DS specifier.
    await write(dir, "design-system/utils/utils.ts", `export { cn } from "@/lib/utils";\n`);
    await write(dir, "src/lib/utils.ts", `export function cn(...a: string[]) { return a.join(" "); }\n`);

    const env = await buildEnv(dir, "design-system/atoms/row.tsx");

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

    const env = await buildEnv(dir, "design-system/atoms/nav-row.tsx");

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

    const env = await buildEnv(dir, "design-system/atoms/month-grid.tsx");

    expect(env.resolve("addDays")).toBeNull();
  });

  // C1 — #263: cross-tier import emits canonical alias, not a sibling-relative path
  it("C1: a DS-composite-exported type resolves to the canonical alias (not a sibling-relative path)", async () => {
    await writeTsconfig({ "@ds/*": ["./design-system/*"] });
    // FileUploadItem is exported from a COMPOSITE, while the file being repaired is an atom.
    // Tier 1 should return "@ds/composites/file-uploader" (the canonical alias), not
    // a sibling-relative "./file-uploader" which doesn't exist from atoms/.
    await write(
      dir,
      "design-system/composites/file-uploader.tsx",
      `export type FileUploadItem = { id: string; file: File; };\nexport function FileUploader() { return <div />; }\n`,
    );

    const env = await buildEnv(dir, "design-system/atoms/row.tsx");

    const result = env.resolve("FileUploadItem");
    expect(result).not.toBeNull();
    // Must be the canonical alias, never a relative path.
    expect(result!.specifier).toBe("@ds/composites/file-uploader");
    expect(result!.specifier).not.toMatch(/^\./);
  });

  // C4 — #263: two symbols from the same module are both imported
  it("C4: two unresolved symbols from the same DS module both get resolved (not just the first)", async () => {
    await writeTsconfig({ "@ds/*": ["./design-system/*"] });
    await write(
      dir,
      "design-system/composites/file-uploader.tsx",
      `export type FileUploadStatus = "idle" | "uploading" | "success" | "error";\nexport type FileUploadItem = { id: string; file: File; status: FileUploadStatus; };\nexport function FileUploader() { return <div />; }\n`,
    );

    const env = await buildEnv(dir, "design-system/atoms/row.tsx");

    // Both types must resolve to the same composite file.
    const item = env.resolve("FileUploadItem");
    const status = env.resolve("FileUploadStatus");
    expect(item).not.toBeNull();
    expect(status).not.toBeNull();
    expect(item!.specifier).toBe("@ds/composites/file-uploader");
    expect(status!.specifier).toBe("@ds/composites/file-uploader");
  });

  // C2 — #263: DS atom name collides with lucide icon → prefer lucide-react
  it("C2: when a DS-atom-defined name is also imported from lucide-react in the project, lucide-react wins (icon collision)", async () => {
    await writeTsconfig({ "@ds/*": ["./design-system/*"] });
    // DS has an atom called Calendar (a DayPicker wrapper — NOT a lucide icon).
    await write(dir, "design-system/atoms/calendar.tsx", `export function Calendar() { return <div />; }\n`);
    // Another file in the project imports Calendar from lucide-react as an icon.
    await write(
      dir,
      "design-system/composites/app-sidebar.tsx",
      `import { Calendar } from "lucide-react";\nexport function AppSidebar() { return <div />; }\n`,
    );

    const env = await buildEnv(dir, "design-system/atoms/sidebar-content.tsx");

    // The lucide-react import from app-sidebar proves Calendar is used as a Lucide icon here.
    // The DS atom of the same name is a collision — lucide-react must win.
    const result = env.resolve("Calendar");
    expect(result).not.toBeNull();
    expect(result!.specifier).toBe("lucide-react");
  });

  it("C2 CONTROL: a DS-atom name with no lucide-react collision still resolves to the DS atom", async () => {
    await writeTsconfig({ "@ds/*": ["./design-system/*"] });
    // Button is in DS; no lucide-react import for Button exists anywhere in the project.
    await write(dir, "design-system/atoms/button.tsx", `export function Button() { return <button />; }\n`);
    // No file imports Button from lucide-react.
    await write(dir, "src/app.tsx", `import { Card } from "some-lib";\nexport const App = () => <Card />;\n`);

    const env = await buildEnv(dir, "design-system/atoms/row.tsx");

    // No lucide collision — should resolve to DS atom.
    const result = env.resolve("Button");
    expect(result).not.toBeNull();
    expect(result!.specifier).toBe("@ds/atoms/button");
  });

  // #263 Bug 2 regression: module-level `import type { X }` must NOT contribute to Tier 3 value-import graph
  it("REGRESSION #263: module-level type import (import type { X }) from a showcase is excluded from Tier 3 value-import graph", async () => {
    await writeTsconfig({ "@ds/*": ["./design-system/*"] });
    // file-uploader.tsx is the COMPOSITE that defines FileUploadItem.
    await write(
      dir,
      "design-system/composites/file-uploader.tsx",
      `export type FileUploadItem = { id: string; };\nexport function FileUploader() { return <div />; }\n`,
    );
    // Showcase imports it with `import type { ... }` — a relative specifier valid only from composites/.
    // This must NOT pollute Tier 3 with the "./file-uploader" relative specifier.
    await write(
      dir,
      "design-system/composites/file-uploader.showcase.tsx",
      `import type { FileUploadItem } from "./file-uploader";\nexport default { title: "FileUploader" };\n`,
    );

    const env = await buildEnv(dir, "design-system/atoms/row.tsx");

    const result = env.resolve("FileUploadItem");
    // Tier 1 (DS export index) must resolve to the canonical alias.
    expect(result).not.toBeNull();
    expect(result!.specifier).toBe("@ds/composites/file-uploader");
    // Must NOT be the relative sibling path from the showcase.
    expect(result!.specifier).not.toMatch(/^\.\//);
  });

  // #263 Tier 3b: module-level `import type { LucideIcon }` from an absolute specifier
  // must still resolve via the type-only graph (not the value graph).
  it("REGRESSION #263: import type { LucideIcon } from lucide-react (absolute) still resolves via type-only Tier 3b", async () => {
    // LucideIcon is NOT defined anywhere in the DS — it's from lucide-react.
    // Multiple DS files import it via `import type { LucideIcon } from "lucide-react"`.
    // After the module-level-type-import fix, those must still feed Tier 3b so LucideIcon resolves.
    await write(
      dir,
      "design-system/atoms/filter-bar.tsx",
      `import type { LucideIcon } from "lucide-react";\nexport function FilterBar({ icon }: { icon?: LucideIcon }) { return <div />; }\n`,
    );
    await write(
      dir,
      "design-system/composites/app-sidebar.tsx",
      `import type { LucideIcon } from "lucide-react";\nexport function AppSidebar() { return <div />; }\n`,
    );

    const env = await buildEnv(dir, "design-system/atoms/nav-row.tsx");

    const result = env.resolve("LucideIcon");
    expect(result).not.toBeNull();
    expect(result!.specifier).toBe("lucide-react");
  });
});
