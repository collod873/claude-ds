import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DriftFinding, DriftRuleId } from "./drift-rules.js";
import { classifySource } from "./classifier.js";
import { locationTierFromPath } from "./three-signal.js";

export interface FixResult {
  finding: DriftFinding;
  fixed: boolean;
  message: string;
}

export type FixerPrompt = (question: string, options: string[]) => Promise<number | "defer">;

export type DriftFixer = (finding: DriftFinding, cwd: string, opts?: FixerOpts) => Promise<FixResult>;

export interface FixerOpts {
  domainRoots?: string[];
  allowedImports?: string[];
  dsAliases?: string[];
  prompt?: FixerPrompt;
}

interface FixerEntry {
  fixer: DriftFixer;
  interactive: boolean;
}

const FIXABLE_RULES: Partial<Record<DriftRuleId, FixerEntry>> = {
  "DRIFT-META-KIND-MISSING": { fixer: fixMetaKindMissing, interactive: false },
};

export function isFixable(ruleId: DriftRuleId): boolean {
  return ruleId in FIXABLE_RULES;
}

export function getFixer(ruleId: DriftRuleId): DriftFixer | null {
  return FIXABLE_RULES[ruleId]?.fixer ?? null;
}

export function isInteractive(ruleId: DriftRuleId): boolean {
  return FIXABLE_RULES[ruleId]?.interactive ?? false;
}

export function makeNoTtyPrompt(): FixerPrompt {
  return async () => "defer";
}

export function makeTtyPrompt(): FixerPrompt {
  return async (question: string, options: string[]): Promise<number | "defer"> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const lines = options.map((opt, i) => `  [${i + 1}] ${opt}`).join("\n");
      const display = `${question}\n${lines}\n  [s] Skip/defer\n> `;
      const answer = await new Promise<string>(resolve => {
        rl.question(display, resolve);
      });
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "s" || trimmed === "skip" || trimmed === "defer") return "defer";
      const num = parseInt(trimmed, 10);
      if (num >= 1 && num <= options.length) return num - 1;
      return "defer";
    } finally {
      rl.close();
    }
  };
}

async function fixMetaKindMissing(finding: DriftFinding, cwd: string, opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}` };
  }

  const locationTier = locationTierFromPath(finding.file);
  const verdict = classifySource(source, opts?.domainRoots, opts?.allowedImports, opts?.dsAliases);
  const tier = locationTier ?? verdict.tier;

  if (tier === "feature" || tier === "unknown") {
    return { finding, fixed: false, message: `cannot determine tier for ${finding.file}` };
  }

  const metaExport = `\nexport const meta = { kind: "${tier}" as const, examples: [] };\n`;
  await writeFile(absPath, source.trimEnd() + "\n" + metaExport, "utf8");

  return { finding, fixed: true, message: `added meta.kind = "${tier}" to ${finding.file}` };
}
