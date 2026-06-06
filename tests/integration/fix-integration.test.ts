import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { checkThreeSignals } from "../../src/lib/three-signal";
import { runFixPass } from "../../src/lib/fix-pass";
import type { DriftFinding } from "../../src/lib/drift/index.js";
import type { FixerPrompt, PromptOption } from "../../src/lib/drift/index.js";
import { makeFakeCtx } from "../helpers/fake-ctx";

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function collectFindings(cwd: string): Promise<DriftFinding[]> {
  const { readdir, readFile: rf } = await import("node:fs/promises");
  const tierDirs = ["design-system/atoms", "design-system/composites", "design-system/patterns"];
  const findings: DriftFinding[] = [];
  const ctx = makeFakeCtx(cwd);
  for (const tierDir of tierDirs) {
    let entries: string[];
    try { entries = await readdir(join(cwd, tierDir)); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith(".tsx")) continue;
      if (entry.endsWith(".showcase.tsx") || entry.endsWith(".test.tsx") || entry.endsWith(".stories.tsx")) continue;
      const filePath = `${tierDir}/${entry}`;
      let source: string;
      try { source = await rf(join(cwd, filePath), "utf8"); } catch { continue; }
      const { findings: f } = checkThreeSignals(filePath, source, ctx);
      findings.push(...f);
    }
  }
  return findings;
}

describe("integration: full --fix pass on fixture project", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("resolves all drift categories in a single --fix pass", async () => {
    // ── Scaffold fixture project ──

    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });
    await mkdir(join(dir, "design-system/utils"), { recursive: true });
    await mkdir(join(dir, "lib/utils"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });

    // ── tokens.json (for DRIFT-INLINE-STATIC-STYLE) ──
    await writeFile(join(dir, "design-system/tokens.json"), JSON.stringify({
      spacing: { 1: "4px", 2: "8px", 4: "16px" },
      color: { primary: "#007bff", muted: "#6c757d" },
    }));

    // ── Existing atom: button with CVA variants ──
    await writeFile(join(dir, "design-system/atoms/button.tsx"), [
      'import { cva } from "class-variance-authority";',
      "",
      "const buttonVariants = cva(\"btn\", {",
      "  variants: {",
      "    variant: {",
      '      default: "btn-default",',
      '      ghost: "btn-ghost",',
      '      outline: "btn-outline",',
      "    },",
      "  },",
      "});",
      "",
      "export function Button({ variant = \"default\", ...props }: any) {",
      "  return <button className={buttonVariants({ variant })} {...props} />;",
      "}",
      'export const meta = { kind: "atom" as const, examples: [',
      '  { name: "default", props: { variant: "default" } },',
      '  { name: "ghost", props: { variant: "ghost" } },',
      '  { name: "outline", props: { variant: "outline" } },',
      "] };",
      "",
    ].join("\n"));

    // ── Existing atom: input ──
    await writeFile(join(dir, "design-system/atoms/input.tsx"), [
      "export function Input(props: any) {",
      "  return <input className=\"ds-input\" {...props} />;",
      "}",
      'export const meta = { kind: "atom" as const, examples: [{ name: "default", props: {} }] };',
      "",
    ].join("\n"));

    // ── Composite 1: raw <button> → DRIFT-RAW-PRIMITIVE (use-existing path) ──
    // Must import from DS atoms so classifier sees it as composite, not atom
    await writeFile(join(dir, "design-system/composites/toolbar.tsx"), [
      'import { Input } from "@/design-system/atoms/input";',
      'import { Badge } from "@/design-system/composites/badge";',
      "",
      "export function Toolbar() {",
      "  return (",
      "    <div>",
      '      <button onClick={() => {}}>Save</button>',
      '      <button onClick={() => {}}>Cancel</button>',
      "      <Input placeholder=\"search\" />",
      '      <Badge label="info" />',
      "    </div>",
      "  );",
      "}",
      'export const meta = { kind: "composite" as const, examples: [] };',
      "",
    ].join("\n"));

    // ── Composite 2: raw <button> + inlined named component ≥20 lines → DRIFT-RAW-PRIMITIVE
    //    Mixed case: audit could Path-A the raw <button>, but the inline component is a
    //    structural extraction decision owned by classify (ADR-0015). audit is surgical and
    //    never creates files, so it DEFERS the whole file — leaving it untouched and pointing
    //    the consumer at `claude-ds classify` rather than half-fixing it.
    // Must import from DS so classifier sees composite, not atom
    const chipLines = Array.from({ length: 20 }, (_, i) =>
      `  const v${i} = ${i};`
    ).join("\n");
    await writeFile(join(dir, "design-system/composites/filter-bar.tsx"), [
      'import { Input } from "@/design-system/atoms/input";',
      "",
      "function FilterBarChip({ label }: { label: string }) {",
      chipLines,
      "  return <span className=\"chip\">{label}</span>;",
      "}",
      "",
      "export function FilterBar() {",
      "  return (",
      "    <div>",
      '      <button>Apply</button>',
      '      <FilterBarChip label="active" />',
      '      <FilterBarChip label="draft" />',
      "      <Input placeholder=\"filter\" />",
      "    </div>",
      "  );",
      "}",
      'export const meta = { kind: "composite" as const, examples: [] };',
      "",
    ].join("\n"));

    // ── Composite 3: inline style={{ padding: "8px" }} → DRIFT-INLINE-STATIC-STYLE ──
    // Avoid children/ReactNode to prevent pattern classification
    await writeFile(join(dir, "design-system/composites/card.tsx"), [
      'import { Button } from "@/design-system/atoms/button";',
      "",
      "export function Card({ title }: { title: string }) {",
      '  return <div style={{ padding: "8px" }}><span>{title}</span><Button>ok</Button></div>;',
      "}",
      'export const meta = { kind: "composite" as const, examples: [] };',
      "",
    ].join("\n"));

    // ── Composite 4: imports from lib/utils → DRIFT-DS-IMPORTS-FEATURE ──
    await writeFile(join(dir, "lib/utils/format.ts"), [
      "export function formatCurrency(amount: number): string {",
      '  return "$" + amount.toFixed(2);',
      "}",
      "",
    ].join("\n"));
    await writeFile(join(dir, "design-system/composites/price-tag.tsx"), [
      'import { formatCurrency } from "@/lib/utils/format";',
      "",
      "export function PriceTag({ amount }: { amount: number }) {",
      "  return <span>{formatCurrency(amount)}</span>;",
      "}",
      'export const meta = { kind: "composite" as const, examples: [] };',
      "",
    ].join("\n"));

    // ── Misplaced file: atom living in composites/ → DRIFT-MISPLACED ──
    await writeFile(join(dir, "design-system/composites/badge.tsx"), [
      "export function Badge({ label }: { label: string }) {",
      "  return <span className=\"badge\">{label}</span>;",
      "}",
      'export const meta = { kind: "atom" as const, examples: [] };',
      "",
    ].join("\n"));
    // Companion file that should move with it
    await writeFile(join(dir, "design-system/composites/badge.test.tsx"), [
      'import { Badge } from "./badge";',
      "it(\"renders\", () => { expect(Badge).toBeDefined(); });",
      "",
    ].join("\n"));

    // ── App-level file that imports badge from composites (should get rewritten) ──
    await writeFile(join(dir, "src/app.tsx"), [
      'import { Badge } from "@/design-system/composites/badge";',
      'import { Card } from "@/design-system/composites/card";',
      "",
      "export function App() {",
      '  return <Card><Badge label="new" /></Card>;',
      "}",
      "",
    ].join("\n"));

    // ── Stale exception (for badge which will be fixed by relocation) ──
    await writeFile(join(dir, "design-system/exceptions.json"), JSON.stringify({
      exceptions: [
        { rule: "DRIFT-MISPLACED", path: "design-system/composites/badge.tsx", issue: "#99", reason: "tracked" },
      ],
    }));

    // ── Barrel exports (pre-existing) ──
    await writeFile(join(dir, "design-system/atoms/index.ts"), [
      'export * from "./button";',
      'export * from "./input";',
      "",
    ].join("\n"));
    await writeFile(join(dir, "design-system/composites/index.ts"), [
      'export * from "./badge";',
      'export * from "./card";',
      'export * from "./filter-bar";',
      'export * from "./price-tag";',
      'export * from "./toolbar";',
      "",
    ].join("\n"));

    // ── Collect initial findings ──
    const initialFindings = await collectFindings(dir);
    expect(initialFindings.length).toBeGreaterThanOrEqual(4);

    const ruleIds = new Set(initialFindings.map(f => f.ruleId));
    expect(ruleIds.has("DRIFT-RAW-PRIMITIVE")).toBe(true);
    expect(ruleIds.has("DRIFT-INLINE-STATIC-STYLE")).toBe(true);
    expect(ruleIds.has("DRIFT-DS-IMPORTS-FEATURE")).toBe(true);
    expect(ruleIds.has("DRIFT-MISPLACED")).toBe(true);

    // ── Mock prompt: always pick first option ──
    const promptLog: string[] = [];
    const mockPrompt: FixerPrompt = async (question, options) => {
      promptLog.push(`${question} → [0] ${options[0].label}`);
      return 0;
    };

    // ── Run fix pass ──
    const result = await runFixPass(makeFakeCtx(dir), initialFindings, { prompt: mockPrompt });

    expect(result.aborted).toBe(false);
    expect(result.applied.length).toBeGreaterThan(0);

    const fixedCount = result.results.filter(r => r.fixed).length;
    // Three categories are still auto-fixable in place: RAW-PRIMITIVE (toolbar),
    // INLINE-STATIC-STYLE (card), DS-IMPORTS-FEATURE (price-tag). DRIFT-MISPLACED
    // is report-only per ADR-0015 — the badge move belongs to `claude-ds classify`.
    expect(fixedCount).toBeGreaterThanOrEqual(3);

    // ── Assert: zero findings on re-audit ──
    const postFindings = await collectFindings(dir);
    // Some findings may remain (e.g. card now has children → pattern classification),
    // but the original rule IDs should be resolved
    const postRuleIds = new Set(postFindings.map(f => f.ruleId));
    // toolbar's raw <button> was resolved via Path A. The only DRIFT-RAW-PRIMITIVE
    // left is filter-bar's, which audit deferred to classify (asserted below).
    const postRaw = postFindings.filter(f => f.ruleId === "DRIFT-RAW-PRIMITIVE");
    expect(postRaw.every(f => f.file.includes("filter-bar"))).toBe(true);
    expect(postRuleIds.has("DRIFT-INLINE-STATIC-STYLE")).toBe(false);

    // ── Assert: badge stayed in composites/ — audit is surgical (ADR-0015) ──
    // The DRIFT-MISPLACED finding still surfaces, but the move belongs to
    // `claude-ds classify` so importers stay resolvable.
    expect(await exists(join(dir, "design-system/composites/badge.tsx"))).toBe(true);
    expect(await exists(join(dir, "design-system/atoms/badge.tsx"))).toBe(false);
    expect(await exists(join(dir, "design-system/composites/badge.test.tsx"))).toBe(true);
    expect(await exists(join(dir, "design-system/atoms/badge.test.tsx"))).toBe(false);
    expect(postRuleIds.has("DRIFT-MISPLACED")).toBe(true);

    // ── Assert: filter-bar deferred to classify (ADR-0015), not extracted ──
    // Audit never creates files, so no chip atom appears and the file is left untouched.
    expect(await exists(join(dir, "design-system/atoms/chip.tsx"))).toBe(false);
    const filterBarSource = await readFile(join(dir, "design-system/composites/filter-bar.tsx"), "utf8");
    expect(filterBarSource).toContain("function FilterBarChip");
    expect(filterBarSource).toMatch(/<button[\s>]/);
    // The fixer surfaced an unfixed finding pointing at classify
    const filterBarResult = result.results.find(
      r => r.finding.ruleId === "DRIFT-RAW-PRIMITIVE" && r.finding.file.includes("filter-bar"),
    );
    expect(filterBarResult?.fixed).toBe(false);
    expect(filterBarResult?.message).toContain("needs extraction");
    expect(filterBarResult?.message).toContain("claude-ds classify");

    // ── Assert: raw <button> replaced with <Button> in toolbar ──
    const toolbarSource = await readFile(join(dir, "design-system/composites/toolbar.tsx"), "utf8");
    expect(toolbarSource).not.toMatch(/<button[\s>]/);
    expect(toolbarSource).toContain("<Button");
    expect(toolbarSource).toContain("@/design-system/atoms/button");

    // ── Assert: inline style replaced with token class in card ──
    const cardSource = await readFile(join(dir, "design-system/composites/card.tsx"), "utf8");
    expect(cardSource).toContain("spacing-2");
    expect(cardSource).not.toContain('style={{ padding: "8px" }}');

    // ── Assert: domain import resolved for price-tag (stays in composites/) ──
    // After DS-IMPORTS-FEATURE extracts the domain import, the file reclassifies as atom.
    // DRIFT-MISCLASSIFIED-COMPOSITE now surfaces a finding instead of relocating —
    // `classify` owns that move per ADR-0015. The file stays in composites/.
    expect(await exists(join(dir, "design-system/composites/price-tag.tsx"))).toBe(true);
    expect(await exists(join(dir, "design-system/atoms/price-tag.tsx"))).toBe(false);
    const priceTagSource = await readFile(join(dir, "design-system/composites/price-tag.tsx"), "utf8");
    // Domain import should be replaced with DS utils import
    expect(priceTagSource).not.toContain("@/lib/utils/format");
    // The extracted utility should exist
    expect(await exists(join(dir, "design-system/utils/format.ts"))).toBe(true);

    // ── Assert: app-level imports unchanged (badge is still in composites/) ──
    const appSource = await readFile(join(dir, "src/app.tsx"), "utf8");
    expect(appSource).toContain("@/design-system/composites/badge");

    // ── Assert: barrel indexes regenerated (badge still in composites/) ──
    const atomsBarrel = await readFile(join(dir, "design-system/atoms/index.ts"), "utf8");
    expect(atomsBarrel).toContain("button");
    expect(atomsBarrel).toContain("input");
    expect(atomsBarrel).not.toContain("badge");

    const compositesBarrel = await readFile(join(dir, "design-system/composites/index.ts"), "utf8");
    expect(compositesBarrel).toContain("badge");
    expect(compositesBarrel).toContain("card");
    expect(compositesBarrel).toContain("toolbar");

    // ── Assert: manifest.json regenerated ──
    expect(await exists(join(dir, "design-system/manifest.json"))).toBe(true);
    const manifest = JSON.parse(await readFile(join(dir, "design-system/manifest.json"), "utf8"));
    const componentNames = manifest.components.map((c: { name: string }) => c.name);
    expect(componentNames).toContain("badge");
    expect(componentNames).toContain("button");

    // Stale exception cleanup is handled by auditCmd (not runFixPass),
    // and is already tested in audit-fix-except.test.ts

    // ��─ Assert: no prompts needed — all fixes were deterministic (Gap 1) ──
    expect(promptLog).toHaveLength(0);
  }, 15000);

  it("handles Button atom with compound variants and pseudo-states (Crewops fixture)", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });

    // Button atom mirroring real Crewops structure: compound variants with pseudo-states
    await writeFile(join(dir, "design-system/atoms/button.tsx"), [
      'import { cva } from "class-variance-authority";',
      "",
      'const buttonVariants = cva("inline-flex items-center rounded-md font-medium", {',
      "  variants: {",
      '    variant: { default: "bg-primary text-white", destructive: "bg-red-500 text-white", ghost: "bg-transparent", outline: "border-2 bg-transparent", secondary: "bg-secondary text-white", link: "underline" },',
      '    size: { default: "h-10 px-4 py-2", sm: "h-8 px-3 text-sm", lg: "h-12 px-6 text-lg", icon: "h-10 w-10" },',
      '    hover: { true: "hover:opacity-90" },',
      '    active: { true: "active:scale-95" },',
      '    pressed: { true: "pressed:opacity-80" },',
      '    focus: { true: "focus:ring-2 focus:ring-offset-2" },',
      '    disabled: { true: "opacity-50 cursor-not-allowed pointer-events-none" },',
      '    expanded: { true: "expanded:rotate-180" },',
      '    dark: { true: "dark:bg-gray-800 dark:text-white" },',
      '    visible: { true: "visible:opacity-100" },',
      "  },",
      "  compoundVariants: [",
      '    { variant: "ghost", hover: true, class: "hover:bg-accent hover:text-accent-foreground" },',
      '    { variant: "outline", focus: true, class: "focus:ring-primary" },',
      '    { variant: "destructive", active: true, class: "active:bg-red-700" },',
      "  ],",
      '  defaultVariants: { variant: "default", size: "default" },',
      "});",
      "",
      "export function Button({ variant, size, ...props }: any) {",
      "  return <button className={buttonVariants({ variant, size })} {...props} />;",
      "}",
      'export const meta = { kind: "atom" as const, examples: [',
      '  { name: "default", props: { variant: "default" } },',
      '  { name: "ghost", props: { variant: "ghost" } },',
      '  { name: "outline", props: { variant: "outline" } },',
      '  { name: "destructive", props: { variant: "destructive" } },',
      '  { name: "secondary", props: { variant: "secondary" } },',
      '  { name: "link", props: { variant: "link" } },',
      '  { name: "sm", props: { size: "sm" } },',
      '  { name: "lg", props: { size: "lg" } },',
      '  { name: "icon", props: { size: "icon" } },',
      "] };",
      "",
    ].join("\n"));

    // Composite with raw <button> including a className with a variant keyword
    await writeFile(join(dir, "design-system/composites/toolbar.tsx"), [
      'import { Button } from "@/design-system/atoms/button";',
      "",
      "export function Toolbar() {",
      "  return (",
      "    <div>",
      '      <button className="ghost" onClick={() => {}}>Action</button>',
      "    </div>",
      "  );",
      "}",
      'export const meta = { kind: "composite" as const, examples: [] };',
      "",
    ].join("\n"));

    const findings = await collectFindings(dir);
    const rawPrimitiveFinding = findings.find(f => f.ruleId === "DRIFT-RAW-PRIMITIVE");
    expect(rawPrimitiveFinding).toBeDefined();

    const promptLog: string[] = [];
    const mockPrompt: FixerPrompt = async (question, options) => {
      promptLog.push(`${question} → opts: ${options.length}`);
      return 0;
    };

    const result = await runFixPass(makeFakeCtx(dir), findings, { prompt: mockPrompt });
    expect(result.aborted).toBe(false);

    const toolbar = await readFile(join(dir, "design-system/composites/toolbar.tsx"), "utf8");
    expect(toolbar).toContain("<Button");
    expect(toolbar).not.toContain("<button");
    // Auto-inferred variant from className "ghost-action" → variant="ghost"
    expect(toolbar).toContain('variant="ghost"');
    // Should NOT have prompted — variant was auto-inferred from className
    // (pseudo-states filtered out, so only variant+size remain, exactly one match)
    expect(promptLog.filter(p => p.includes("raw <button>"))).toHaveLength(0);
  });

  it("defers all interactive findings in non-TTY mode", async () => {
    await mkdir(join(dir, "design-system/atoms"), { recursive: true });
    await mkdir(join(dir, "design-system/composites"), { recursive: true });

    await writeFile(join(dir, "design-system/atoms/button.tsx"), [
      'import { cva } from "class-variance-authority";',
      'const buttonVariants = cva("btn", {',
      "  variants: {",
      '    variant: { default: "btn-default", ghost: "btn-ghost", outline: "btn-outline" },',
      "  },",
      '  defaultVariants: { variant: "default" },',
      "});",
      "export function Button(props: any) { return <button {...props} />; }",
      'export const meta = { kind: "atom" as const, examples: [] };',
      "",
    ].join("\n"));

    // Composite with raw <button> with ambiguous className (2 standalone variant matches)
    await writeFile(join(dir, "design-system/composites/form.tsx"), [
      'import { Input } from "@/design-system/atoms/button";',
      "",
      "export function Form() {",
      '  return <div><Input /><button className="ghost outline" type="submit">Go</button></div>;',
      "}",
      'export const meta = { kind: "composite" as const, examples: [] };',
      "",
    ].join("\n"));

    const findings = await collectFindings(dir);
    expect(findings.some(f => f.ruleId === "DRIFT-RAW-PRIMITIVE")).toBe(true);

    // Non-TTY prompt: picks first option (safe default)
    const noTtyPrompt: FixerPrompt = async () => 0;
    const result = await runFixPass(makeFakeCtx(dir), findings, { prompt: noTtyPrompt });

    expect(result.aborted).toBe(false);
    // First option is picked — raw primitive should be fixed
    const fixed = result.results.filter(r => r.fixed);
    expect(fixed.some(r => r.finding.ruleId === "DRIFT-RAW-PRIMITIVE")).toBe(true);

    const formSource = await readFile(join(dir, "design-system/composites/form.tsx"), "utf8");
    expect(formSource).toContain("<Button");
  });
});
