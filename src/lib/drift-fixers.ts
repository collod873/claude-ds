import { readFile, writeFile, readdir, rename, mkdir } from "node:fs/promises";
import { join, basename, dirname, extname } from "node:path";
import { createInterface } from "node:readline";
import type { DriftFinding, DriftRuleId } from "./drift-rules.js";
import type { Tier } from "./classifier.js";
import { classifySource } from "./classifier.js";
import { locationTierFromPath, metaKindFromSource } from "./three-signal.js";
import { rewriteImportPaths } from "./ops/rewrite-imports.js";

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
  "DRIFT-MISPLACED": { fixer: fixMisplaced, interactive: false },
  "DRIFT-MISCLASSIFIED-ATOM": { fixer: fixMisclassified, interactive: false },
  "DRIFT-MISCLASSIFIED-COMPOSITE": { fixer: fixMisclassified, interactive: false },
  "DRIFT-INLINE-STATIC-STYLE": { fixer: fixInlineStaticStyle, interactive: true },
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

const TIER_FOLDERS: Record<string, string> = {
  atom: "atoms",
  composite: "composites",
  pattern: "patterns",
};

const COMPANION_RE = /^\.(showcase|test|stories|snapshot)\./;

const META_KIND_REPLACE_RE = /(\bmeta\s*=\s*\{[^}]*\bkind\s*:\s*["'])\w+(["'])/s;

async function findCompanionFiles(absDir: string, baseName: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch {
    return [];
  }
  return entries.filter(entry => {
    if (!entry.startsWith(baseName)) return false;
    return COMPANION_RE.test(entry.slice(baseName.length));
  });
}

async function updateBarrelExports(
  cwd: string,
  sourceDir: string,
  destDir: string,
  baseName: string,
): Promise<void> {
  const srcBarrelPath = join(cwd, sourceDir, "index.ts");
  try {
    const content = await readFile(srcBarrelPath, "utf8");
    const lines = content.split("\n");
    const movedLines: string[] = [];
    const kept = lines.filter(line => {
      if (line.includes(`"./${baseName}"`) || line.includes(`'./${baseName}'`)) {
        movedLines.push(line);
        return false;
      }
      return true;
    });
    if (movedLines.length > 0) {
      await writeFile(srcBarrelPath, kept.join("\n"), "utf8");
    }

    const dstBarrelPath = join(cwd, destDir, "index.ts");
    try {
      let dstContent = await readFile(dstBarrelPath, "utf8");
      for (const line of movedLines) {
        if (line.trim()) dstContent = dstContent.trimEnd() + "\n" + line + "\n";
      }
      await writeFile(dstBarrelPath, dstContent, "utf8");
    } catch {
      // destination barrel doesn't exist — skip
    }
  } catch {
    // source barrel doesn't exist — skip
  }
}

async function relocateFile(
  finding: DriftFinding,
  cwd: string,
  targetTier: Tier,
  opts?: FixerOpts,
): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  const locationTier = locationTierFromPath(finding.file);
  const targetFolder = TIER_FOLDERS[targetTier];
  if (!targetFolder || !locationTier) {
    return { finding, fixed: false, message: `cannot determine target for ${finding.file}` };
  }
  const sourceFolder = TIER_FOLDERS[locationTier];
  if (!sourceFolder) {
    return { finding, fixed: false, message: `cannot determine source tier for ${finding.file}` };
  }

  const fileName = basename(finding.file);
  const baseName = fileName.slice(0, -extname(fileName).length);
  const sourceDir = dirname(finding.file);
  const segments = finding.file.replace(/\\/g, "/").split("/");
  const dsIdx = segments.indexOf("design-system");
  const dsRoot = segments.slice(0, dsIdx + 1).join("/");
  const targetDir = `${dsRoot}/${targetFolder}`;

  await mkdir(join(cwd, targetDir), { recursive: true });

  const companions = await findCompanionFiles(join(cwd, sourceDir), baseName);

  await rename(absPath, join(cwd, targetDir, fileName));

  for (const comp of companions) {
    await rename(join(cwd, sourceDir, comp), join(cwd, targetDir, comp));
  }

  await rewriteImportPaths(cwd, `${sourceFolder}/${baseName}`, `${targetFolder}/${baseName}`);

  await updateBarrelExports(cwd, sourceDir, targetDir, baseName);

  const newAbsPath = join(cwd, targetDir, fileName);
  const newSource = await readFile(newAbsPath, "utf8");
  const currentMetaKind = metaKindFromSource(newSource);
  if (currentMetaKind && currentMetaKind !== targetTier) {
    const updated = newSource.replace(META_KIND_REPLACE_RE, `$1${targetTier}$2`);
    if (updated !== newSource) await writeFile(newAbsPath, updated, "utf8");
  }

  const movedCount = 1 + companions.length;
  return {
    finding,
    fixed: true,
    message: `relocated ${movedCount} file${movedCount > 1 ? "s" : ""} from ${sourceDir} to ${targetDir}`,
  };
}

async function fixMisplaced(finding: DriftFinding, cwd: string, opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}` };
  }

  const verdict = classifySource(source, opts?.domainRoots, opts?.allowedImports, opts?.dsAliases);
  if (verdict.tier === "feature" || verdict.tier === "unknown" || verdict.tier === "pattern") {
    return { finding, fixed: false, message: `cannot relocate ${finding.file} — classifier says ${verdict.tier}` };
  }

  return relocateFile(finding, cwd, verdict.tier, opts);
}

// --- DRIFT-INLINE-STATIC-STYLE fixer ---

interface TokenEntry {
  className: string;
  value: string;
  group: string;
}

function flattenTokens(obj: unknown, prefix: string[] = []): TokenEntry[] {
  const entries: TokenEntry[] = [];
  if (obj === null || obj === undefined || typeof obj !== "object") return entries;
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const path = [...prefix, key];
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      entries.push(...flattenTokens(val, path));
    } else {
      entries.push({
        className: path.join("-"),
        value: String(val),
        group: prefix[0] ?? key,
      });
    }
  }
  return entries;
}

const CSS_PROP_TOKEN_GROUP: Record<string, string> = {
  color: "color",
  backgroundColor: "color",
  borderColor: "color",
  outlineColor: "color",
  fill: "color",
  stroke: "color",
  zIndex: "z",
  boxShadow: "shadow",
  transitionDuration: "motion",
  animationDuration: "motion",
  transitionTimingFunction: "motion",
};

function lookupToken(
  entries: TokenEntry[],
  cssProp: string,
  rawValue: string,
): TokenEntry[] {
  const group = CSS_PROP_TOKEN_GROUP[cssProp];
  return entries.filter(e => {
    if (e.value !== rawValue) return false;
    if (group && e.group !== group) return false;
    return true;
  });
}

const STYLE_PROP_RE = /([a-zA-Z_$][\w$]*)\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`$]*`|-?\d+(?:\.\d+)?|true|false|null|undefined)/g;

interface StyleProp {
  name: string;
  rawValue: string;
  normalizedValue: string;
}

function parseStyleProps(innerBlock: string): StyleProp[] {
  const props: StyleProp[] = [];
  let m: RegExpExecArray | null;
  STYLE_PROP_RE.lastIndex = 0;
  while ((m = STYLE_PROP_RE.exec(innerBlock)) !== null) {
    const rawValue = m[2];
    let normalizedValue = rawValue;
    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'")) ||
      (rawValue.startsWith("`") && rawValue.endsWith("`"))
    ) {
      normalizedValue = rawValue.slice(1, -1);
    }
    props.push({ name: m[1], rawValue, normalizedValue });
  }
  return props;
}

const STATIC_STYLE_BLOCK_RE = new RegExp(
  "(style\\s*=\\s*\\{\\{\\s*)" +
  "(" +
    "(?:" +
      "[a-zA-Z_$][\\w$]*\\s*:\\s*" +
      "(?:" +
        "'(?:[^'\\\\]|\\\\.)*'" +
        '|"(?:[^"\\\\]|\\\\.)*"' +
        "|`[^`$]*`" +
        "|-?\\d+(?:\\.\\d+)?" +
        "|true|false|null|undefined" +
      ")" +
      "\\s*,?\\s*" +
    ")+" +
  ")" +
  "(\\}\\})",
  "g",
);

async function fixInlineStaticStyle(finding: DriftFinding, cwd: string, opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}` };
  }

  let tokensRaw: string;
  try {
    tokensRaw = await readFile(join(cwd, "design-system/tokens.json"), "utf8");
  } catch {
    return { finding, fixed: false, message: "could not read design-system/tokens.json" };
  }

  let tokens: unknown;
  try {
    tokens = JSON.parse(tokensRaw);
  } catch {
    return { finding, fixed: false, message: "could not parse design-system/tokens.json" };
  }

  const tokenEntries = flattenTokens(tokens);
  let anyFixed = false;
  let result = source;

  STATIC_STYLE_BLOCK_RE.lastIndex = 0;
  const replacements: Array<{ original: string; replacement: string }> = [];

  let match: RegExpExecArray | null;
  while ((match = STATIC_STYLE_BLOCK_RE.exec(source)) !== null) {
    const fullMatch = match[0];
    const innerBlock = match[2];
    const props = parseStyleProps(innerBlock);

    const resolved: Array<{ prop: StyleProp; className: string }> = [];
    const unresolved: StyleProp[] = [];

    for (const prop of props) {
      const matches = lookupToken(tokenEntries, prop.name, prop.normalizedValue);
      if (matches.length === 1) {
        resolved.push({ prop, className: matches[0].className });
      } else if (matches.length > 1 && opts?.prompt) {
        const options = matches.map(m => m.className);
        const choice = await opts.prompt(
          `Ambiguous token match for ${prop.name}: ${prop.normalizedValue}`,
          options,
        );
        if (choice === "defer") {
          unresolved.push(prop);
        } else {
          resolved.push({ prop, className: matches[choice].className });
        }
      } else {
        unresolved.push(prop);
      }
    }

    if (resolved.length === 0) continue;

    const classNames = resolved.map(r => r.className).join(" ");
    let replacement: string;

    if (unresolved.length === 0) {
      replacement = `className="${classNames}"`;
    } else {
      const remaining = unresolved
        .map(p => `${p.name}: ${p.rawValue}`)
        .join(", ");
      replacement = `className="${classNames}" style={{ ${remaining} }}`;
    }

    replacements.push({ original: fullMatch, replacement });
  }

  for (const { original, replacement } of replacements) {
    const beforeReplace = result;
    result = result.replace(original, replacement);
    if (result !== beforeReplace) anyFixed = true;
  }

  if (!anyFixed) {
    return { finding, fixed: false, message: `no token matches found for ${finding.file}` };
  }

  // Merge new className with any existing className on the same element
  result = result.replace(
    /className="([^"]*?)"\s+className="([^"]*?)"/g,
    (_m, existing: string, added: string) => `className="${existing} ${added}"`,
  );

  await writeFile(absPath, result, "utf8");
  return { finding, fixed: true, message: `replaced inline styles with token classes in ${finding.file}` };
}

async function fixMisclassified(finding: DriftFinding, cwd: string, opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}` };
  }

  const locationTier = locationTierFromPath(finding.file);
  const verdict = classifySource(source, opts?.domainRoots, opts?.allowedImports, opts?.dsAliases);

  if (verdict.tier === "feature" || verdict.tier === "unknown" || verdict.tier === "pattern") {
    return { finding, fixed: false, message: `cannot fix ${finding.file} — classifier says ${verdict.tier}` };
  }

  if (locationTier === verdict.tier) {
    const updated = source.replace(META_KIND_REPLACE_RE, `$1${verdict.tier}$2`);
    if (updated === source) {
      return { finding, fixed: false, message: `could not rewrite meta.kind in ${finding.file}` };
    }
    await writeFile(absPath, updated, "utf8");
    return { finding, fixed: true, message: `flipped meta.kind to "${verdict.tier}" in ${finding.file}` };
  }

  return relocateFile(finding, cwd, verdict.tier, opts);
}
