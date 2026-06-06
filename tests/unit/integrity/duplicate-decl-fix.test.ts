import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { freshTmpDir, cleanup } from "../../helpers/tmpdir";
import { integrityFixerAsOperation, evaluateIntegrity, isIntegrityFixable } from "../../../src/lib/integrity/index";
import type { IntegrityFinding } from "../../../src/lib/integrity/index";
import type { ProjectContext } from "../../../src/lib/project";

async function write(dir: string, rel: string, content: string): Promise<void> {
  await mkdir(join(dir, rel, ".."), { recursive: true });
  await writeFile(join(dir, rel), content);
}

const finding = (file: string): IntegrityFinding => ({
  ruleId: "INTEGRITY-DUPLICATE-DECL",
  file,
  message: "Declares 1 top-level function(s) more than once: Widget",
});

describe("INTEGRITY-DUPLICATE-DECL fix", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("is fixable", () => {
    expect(isIntegrityFixable("INTEGRITY-DUPLICATE-DECL")).toBe(true);
  });

  it("drops the redundant copy when the two implementations are identical", async () => {
    const body = `function Widget() {\n  return <span>hi</span>;\n}\n`;
    const broken = `${body}\n${body}\nexport { Widget };\n`;
    await write(dir, "design-system/atoms/widget.tsx", broken);

    const op = integrityFixerAsOperation(finding("design-system/atoms/widget.tsx"));
    const { changes, outcome } = await op.plan({ cwd: dir } as unknown as ProjectContext);

    expect(outcome.fixed).toBe(true);
    expect(changes).toHaveLength(1);
    const after = changes[0].kind === "write" ? changes[0].after.toString("utf8") : "";
    // Exactly one implementation remains — no duplicate-decl finding left.
    expect(evaluateIntegrity("design-system/atoms/widget.tsx", after)).toEqual([]);
    expect(after.match(/function Widget\(/g)?.length).toBe(1);
  });

  it("merges an export-modifier-only twin, keeping the exported copy (the Crewops corruption shape)", async () => {
    // The real corruption: a component declared twice, bodies identical except
    // the `export` keyword on the second — `getText()` differs only by modifier.
    const body = `  return <button>Step</button>;\n`;
    const broken =
      `import { cn } from "@ds/utils/utils";\n\n` +
      `function StepperButton() {\n${body}}\n\n` +
      `export function StepperButton() {\n${body}}\n`;
    await write(dir, "design-system/atoms/stepper-button.tsx", broken);

    const op = integrityFixerAsOperation(finding("design-system/atoms/stepper-button.tsx"));
    const { changes, outcome } = await op.plan({ cwd: dir } as unknown as ProjectContext);

    expect(outcome.fixed).toBe(true);
    expect(changes).toHaveLength(1);
    const after = changes[0].kind === "write" ? changes[0].after.toString("utf8") : "";
    // Exactly one implementation remains — and it is the exported one.
    expect(after.match(/function StepperButton\(/g)?.length).toBe(1);
    expect(after).toMatch(/export function StepperButton\(/);
    expect(evaluateIntegrity("design-system/atoms/stepper-button.tsx", after).some(
      f => f.ruleId === "INTEGRITY-DUPLICATE-DECL",
    )).toBe(false);
  });

  it("REGRESSION: leaves the finding when the two implementations differ — won't pick a winner", async () => {
    const broken =
      `function Widget() {\n  return <span>A</span>;\n}\n\n` +
      `function Widget() {\n  return <span>B-different</span>;\n}\n`;
    await write(dir, "design-system/atoms/widget.tsx", broken);

    const op = integrityFixerAsOperation(finding("design-system/atoms/widget.tsx"));
    const { changes, outcome } = await op.plan({ cwd: dir } as unknown as ProjectContext);

    expect(outcome.fixed).toBe(false);
    expect(changes).toHaveLength(0);
    const onDisk = await readFile(join(dir, "design-system/atoms/widget.tsx"), "utf8");
    expect(onDisk).toBe(broken);
    expect(evaluateIntegrity("design-system/atoms/widget.tsx", onDisk).some(f => f.ruleId === "INTEGRITY-DUPLICATE-DECL")).toBe(true);
  });
});
