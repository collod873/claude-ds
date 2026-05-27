import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename, dirname, extname, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { DriftFinding, DriftRuleId } from "./drift-rules.js";
import { parseCvaVariants } from "./drift-rules.js";
import type { Tier } from "./classifier.js";
import { classifySource, DEFAULT_DOMAIN_ROOTS } from "./classifier.js";
import { locationTierFromPath, metaKindFromSource } from "./three-signal.js";

import type { Change } from "./operation.js";

export interface FixResult {
  finding: DriftFinding;
  fixed: boolean;
  message: string;
  changes: Change[];
}

export interface PromptOption {
  label: string;
  description: string;
}

export type FixerPrompt = (question: string, options: PromptOption[]) => Promise<number | "defer">;

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
  priority: number;
}

const FIXABLE_RULES: Partial<Record<DriftRuleId, FixerEntry>> = {
  "DRIFT-META-KIND-MISSING": { fixer: fixMetaKindMissing, interactive: false, priority: 3 },
  "DRIFT-MISPLACED": { fixer: fixMisplaced, interactive: false, priority: 1 },
  "DRIFT-MISCLASSIFIED-ATOM": { fixer: fixMisclassified, interactive: false, priority: 3 },
  "DRIFT-MISCLASSIFIED-COMPOSITE": { fixer: fixMisclassified, interactive: false, priority: 3 },
  "DRIFT-INLINE-STATIC-STYLE": { fixer: fixInlineStaticStyle, interactive: false, priority: 2 },
  "DRIFT-DS-IMPORTS-FEATURE": { fixer: fixDsImportsFeature, interactive: false, priority: 2 },
  "DRIFT-RAW-PRIMITIVE": { fixer: fixRawPrimitive, interactive: false, priority: 0 },
  "DRIFT-CVA-VARIANT-UNRENDERED": { fixer: fixCvaVariantUnrendered, interactive: false, priority: 3 },
  "DRIFT-META-EXAMPLES-DUPLICATE": { fixer: fixMetaExamplesDuplicate, interactive: false, priority: 4 },
  "DRIFT-META-EXAMPLES-CORRUPT": { fixer: fixMetaExamplesCorrupt, interactive: false, priority: 5 },
  "DRIFT-STALE-DS-IMPORT": { fixer: fixStaleDsImport, interactive: false, priority: 0 },
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

export function getFixerPriority(ruleId: DriftRuleId): number {
  return FIXABLE_RULES[ruleId]?.priority ?? Infinity;
}

export function makeNoTtyPrompt(): FixerPrompt {
  return async () => 0;
}

export function makeTtyPrompt(): FixerPrompt {
  return async (question: string, options: PromptOption[]): Promise<number | "defer"> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const maxOptions = 5;
      const displayOptions = options.length > maxOptions
        ? [...options.slice(0, maxOptions - 1), { label: `... and ${options.length - maxOptions + 1} more`, description: "defer to review" }]
        : options;
      const lines = displayOptions.map((opt, i) => `  \x1b[36m[${i + 1}]\x1b[0m ${opt.label} — ${opt.description}`).join("\n");
      const display = `\n\x1b[1m${question}\x1b[0m\n${lines}\n  \x1b[90m[s] Skip/defer\x1b[0m\n\x1b[36m>\x1b[0m `;
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
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const locationTier = locationTierFromPath(finding.file);
  const verdict = classifySource(source, opts?.domainRoots, opts?.allowedImports, opts?.dsAliases);
  const tier = locationTier ?? verdict.tier;

  if (tier === "feature" || tier === "unknown") {
    return { finding, fixed: false, message: `cannot determine tier for ${finding.file}`, changes: [] };
  }

  const metaExport = `\nexport const meta = { kind: "${tier}" as const, examples: [] };\n`;
  const newContent = source.trimEnd() + "\n" + metaExport;
  const changes: Change[] = [{
    kind: "write",
    path: finding.file,
    before: Buffer.from(source),
    after: Buffer.from(newContent),
  }];

  return { finding, fixed: true, message: `added meta.kind = "${tier}" to ${finding.file}`, changes };
}

async function collectTierImportRewriteChanges(
  cwd: string,
  fromSegment: string,
  toSegment: string,
): Promise<Change[]> {
  const fromPath = `@/design-system/${fromSegment}`;
  const toPath = `@/design-system/${toSegment}`;
  const changes: Change[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const full = join(dir, entry);
      let s;
      try { s = await stat(full); } catch { continue; }
      if (s.isDirectory()) { await walk(full); continue; }
      if (!s.isFile()) continue;
      if (!(entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".js") || entry.endsWith(".jsx"))) continue;
      let content: string;
      try { content = await readFile(full, "utf8"); } catch { continue; }
      if (content.includes(fromPath)) {
        const updated = content.split(fromPath).join(toPath);
        const relPath = full.slice(cwd.length + 1);
        changes.push({
          kind: "write",
          path: relPath,
          before: Buffer.from(content),
          after: Buffer.from(updated),
        });
      }
    }
  }
  await walk(cwd);
  return changes;
}

async function collectProjectImportRewriteChanges(
  cwd: string,
  oldImportPath: string,
  newImportPath: string,
): Promise<Change[]> {
  const changes: Change[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const full = join(dir, entry);
      let s;
      try { s = await stat(full); } catch { continue; }
      if (s.isDirectory()) { await walk(full); continue; }
      if (!s.isFile()) continue;
      if (!(entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".js") || entry.endsWith(".jsx"))) continue;
      let content: string;
      try { content = await readFile(full, "utf8"); } catch { continue; }
      if (content.includes(oldImportPath)) {
        const updated = content.split(oldImportPath).join(newImportPath);
        const relPath = full.slice(cwd.length + 1);
        changes.push({
          kind: "write",
          path: relPath,
          before: Buffer.from(content),
          after: Buffer.from(updated),
        });
      }
    }
  }
  await walk(cwd);
  return changes;
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
  changes: Change[],
): Promise<void> {
  const srcBarrelRel = join(sourceDir, "index.ts");
  const srcBarrelPath = join(cwd, srcBarrelRel);
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
      changes.push({
        kind: "write",
        path: srcBarrelRel,
        before: Buffer.from(content),
        after: Buffer.from(kept.join("\n")),
      });
    }

    const dstBarrelRel = join(destDir, "index.ts");
    const dstBarrelPath = join(cwd, dstBarrelRel);
    try {
      let dstContent = await readFile(dstBarrelPath, "utf8");
      const originalDst = dstContent;
      for (const line of movedLines) {
        if (line.trim()) dstContent = dstContent.trimEnd() + "\n" + line + "\n";
      }
      if (dstContent !== originalDst) {
        changes.push({
          kind: "write",
          path: dstBarrelRel,
          before: Buffer.from(originalDst),
          after: Buffer.from(dstContent),
        });
      }
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
  source: string,
  targetTier: Tier,
  opts?: FixerOpts,
): Promise<FixResult> {
  const locationTier = locationTierFromPath(finding.file);
  const targetFolder = TIER_FOLDERS[targetTier];
  if (!targetFolder || !locationTier) {
    return { finding, fixed: false, message: `cannot determine target for ${finding.file}`, changes: [] };
  }
  const sourceFolder = TIER_FOLDERS[locationTier];
  if (!sourceFolder) {
    return { finding, fixed: false, message: `cannot determine source tier for ${finding.file}`, changes: [] };
  }

  const fileName = basename(finding.file);
  const baseName = fileName.slice(0, -extname(fileName).length);
  const sourceDir = dirname(finding.file);
  const segments = finding.file.replace(/\\/g, "/").split("/");
  const dsIdx = segments.indexOf("design-system");
  const dsRoot = segments.slice(0, dsIdx + 1).join("/");
  const targetDir = `${dsRoot}/${targetFolder}`;

  const changes: Change[] = [];

  const companions = await findCompanionFiles(join(cwd, sourceDir), baseName);

  changes.push({ kind: "rename", path: finding.file, after: `${targetDir}/${fileName}` });

  for (const comp of companions) {
    changes.push({ kind: "rename", path: `${sourceDir}/${comp}`, after: `${targetDir}/${comp}` });
  }

  const importChanges = await collectTierImportRewriteChanges(
    cwd, `${sourceFolder}/${baseName}`, `${targetFolder}/${baseName}`,
  );
  changes.push(...importChanges);

  await updateBarrelExports(cwd, sourceDir, targetDir, baseName, changes);

  const currentMetaKind = metaKindFromSource(source);
  if (currentMetaKind && currentMetaKind !== targetTier) {
    const updated = source.replace(META_KIND_REPLACE_RE, `$1${targetTier}$2`);
    if (updated !== source) {
      changes.push({
        kind: "write",
        path: `${targetDir}/${fileName}`,
        before: Buffer.from(source),
        after: Buffer.from(updated),
      });
    }
  }

  const movedCount = 1 + companions.length;
  return {
    finding,
    fixed: true,
    message: `relocated ${movedCount} file${movedCount > 1 ? "s" : ""} from ${sourceDir} to ${targetDir}`,
    changes,
  };
}

async function fixMisplaced(finding: DriftFinding, cwd: string, opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const verdict = classifySource(source, opts?.domainRoots, opts?.allowedImports, opts?.dsAliases);
  if (verdict.tier === "feature" || verdict.tier === "unknown" || verdict.tier === "pattern") {
    return { finding, fixed: false, message: `cannot relocate ${finding.file} — classifier says ${verdict.tier}`, changes: [] };
  }

  return relocateFile(finding, cwd, source, verdict.tier, opts);
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
  padding: "spacing",
  paddingTop: "spacing",
  paddingBottom: "spacing",
  paddingLeft: "spacing",
  paddingRight: "spacing",
  margin: "spacing",
  marginTop: "spacing",
  marginBottom: "spacing",
  marginLeft: "spacing",
  marginRight: "spacing",
  gap: "spacing",
  rowGap: "spacing",
  columnGap: "spacing",
};

function normalizeTokenValue(value: string): string {
  return value.toLowerCase().trim();
}

function valuesMatch(tokenValue: string, sourceValue: string): boolean {
  if (tokenValue === sourceValue) return true;
  const normToken = normalizeTokenValue(tokenValue);
  const normSource = normalizeTokenValue(sourceValue);
  if (normToken === normSource) return true;
  // Strip units from source (e.g., "16px" → "16") and compare to token
  const strippedSource = normSource.replace(/^(-?\d+(?:\.\d+)?)\s*(px|rem|em|%)$/, "$1");
  if (normToken === strippedSource) return true;
  // Token might have units, source might not
  const strippedToken = normToken.replace(/^(-?\d+(?:\.\d+)?)\s*(px|rem|em|%)$/, "$1");
  if (strippedToken === normSource) return true;
  return false;
}

function lookupToken(
  entries: TokenEntry[],
  cssProp: string,
  rawValue: string,
): TokenEntry[] {
  const group = CSS_PROP_TOKEN_GROUP[cssProp];
  return entries.filter(e => {
    if (!valuesMatch(e.value, rawValue)) return false;
    if (group && e.group !== group) return false;
    return true;
  });
}

function extractNumeric(value: string): number | null {
  const m = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:px|rem|em|%)?$/);
  return m ? parseFloat(m[1]) : null;
}

interface NearestTokenResult {
  token: TokenEntry;
  distance: number;
  equidistantPeer: TokenEntry | null;
}

function findNearestNumericToken(
  entries: TokenEntry[],
  cssProp: string,
  rawValue: string,
): NearestTokenResult | null {
  const sourceNum = extractNumeric(rawValue);
  if (sourceNum === null) return null;

  const group = CSS_PROP_TOKEN_GROUP[cssProp];
  const candidates = entries.filter(e => {
    if (group && e.group !== group) return false;
    return extractNumeric(e.value) !== null;
  });

  if (candidates.length === 0) return null;

  let best: TokenEntry | null = null;
  let bestDist = Infinity;
  let equidistant: TokenEntry | null = null;

  for (const c of candidates) {
    const d = Math.abs(extractNumeric(c.value)! - sourceNum);
    if (d < bestDist) {
      best = c;
      bestDist = d;
      equidistant = null;
    } else if (d === bestDist && best !== null) {
      equidistant = c;
    }
  }

  if (!best) return null;

  const threshold = Math.abs(sourceNum) * 2;
  if (bestDist > threshold) return null;

  return { token: best, distance: bestDist, equidistantPeer: equidistant };
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
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  let tokensRaw: string;
  try {
    tokensRaw = await readFile(join(cwd, "design-system/tokens.json"), "utf8");
  } catch {
    return { finding, fixed: false, message: "could not read design-system/tokens.json", changes: [] };
  }

  let tokens: unknown;
  try {
    tokens = JSON.parse(tokensRaw);
  } catch {
    return { finding, fixed: false, message: "could not parse design-system/tokens.json", changes: [] };
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
      } else if (matches.length > 1) {
        resolved.push({ prop, className: matches[0].className });
      } else {
        const nearest = findNearestNumericToken(tokenEntries, prop.name, prop.normalizedValue);
        if (!nearest) {
          unresolved.push(prop);
        } else if (nearest.equidistantPeer && opts?.prompt) {
          const options = [
            { label: nearest.token.className, description: `Use token class "${nearest.token.className}" (value: ${nearest.token.value})` },
            { label: nearest.equidistantPeer.className, description: `Use token class "${nearest.equidistantPeer.className}" (value: ${nearest.equidistantPeer.value})` },
          ];
          const choice = await opts.prompt(
            `${finding.file}: "${prop.name}: ${prop.normalizedValue}" is equidistant from two tokens`,
            options,
          );
          if (choice === "defer") {
            unresolved.push(prop);
          } else {
            resolved.push({ prop, className: options[choice].label });
          }
        } else if (nearest.equidistantPeer) {
          unresolved.push(prop);
        } else {
          resolved.push({ prop, className: nearest.token.className });
        }
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
    return { finding, fixed: false, message: `no token matches found for ${finding.file}`, changes: [] };
  }

  result = result.replace(
    /className="([^"]*?)"\s+className="([^"]*?)"/g,
    (_m, existing: string, added: string) => `className="${existing} ${added}"`,
  );

  const changes: Change[] = [{
    kind: "write",
    path: finding.file,
    before: Buffer.from(source),
    after: Buffer.from(result),
  }];
  return { finding, fixed: true, message: `replaced inline styles with token classes in ${finding.file}`, changes };
}

async function fixMisclassified(finding: DriftFinding, cwd: string, opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const locationTier = locationTierFromPath(finding.file);
  const verdict = classifySource(source, opts?.domainRoots, opts?.allowedImports, opts?.dsAliases);

  if (verdict.tier === "feature" || verdict.tier === "unknown" || verdict.tier === "pattern") {
    return { finding, fixed: false, message: `cannot fix ${finding.file} — classifier says ${verdict.tier}`, changes: [] };
  }

  if (locationTier === verdict.tier) {
    const updated = source.replace(META_KIND_REPLACE_RE, `$1${verdict.tier}$2`);
    if (updated === source) {
      return { finding, fixed: false, message: `could not rewrite meta.kind in ${finding.file}`, changes: [] };
    }
    const changes: Change[] = [{
      kind: "write",
      path: finding.file,
      before: Buffer.from(source),
      after: Buffer.from(updated),
    }];
    return { finding, fixed: true, message: `flipped meta.kind to "${verdict.tier}" in ${finding.file}`, changes };
  }

  return relocateFile(finding, cwd, source, verdict.tier, opts);
}

// --- DRIFT-DS-IMPORTS-FEATURE fixer ---

interface DomainImport {
  symbols: string[];
  importPath: string;
  fullLine: string;
}

const IMPORT_STMT_RE = /^import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']\s*;?\s*$/gm;

function parseDomainImports(source: string, domainRoots: string[]): DomainImport[] {
  const results: DomainImport[] = [];
  let m: RegExpExecArray | null;
  IMPORT_STMT_RE.lastIndex = 0;
  while ((m = IMPORT_STMT_RE.exec(source)) !== null) {
    const importPath = m[2];
    const isDomain = domainRoots.some(root => {
      const re = new RegExp(`(?:^|/)${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`);
      return re.test(importPath);
    });
    if (!isDomain) continue;
    const symbols = m[1].split(",").map(s => s.trim()).filter(Boolean);
    results.push({ symbols, importPath, fullLine: m[0] });
  }
  return results;
}

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx"];

async function resolveImportFile(
  importPath: string,
  fromFileRel: string,
  cwd: string,
): Promise<string | null> {
  let candidate: string;
  if (importPath.startsWith("@/")) {
    candidate = join(cwd, importPath.slice(2));
  } else {
    const fromDir = dirname(join(cwd, fromFileRel));
    candidate = resolve(fromDir, importPath);
  }

  for (const ext of RESOLVE_EXTS) {
    try {
      const s = await stat(candidate + ext);
      if (s.isFile()) return candidate + ext;
    } catch { /* not found */ }
  }
  try {
    const s = await stat(candidate);
    if (s.isFile()) return candidate;
  } catch { /* not found */ }
  for (const ext of RESOLVE_EXTS) {
    try {
      const s = await stat(join(candidate, `index${ext}`));
      if (s.isFile()) return join(candidate, `index${ext}`);
    } catch { /* not found */ }
  }
  return null;
}

function sourceHasDomainDeps(source: string, domainRoots: string[]): boolean {
  for (const root of domainRoots) {
    const re = new RegExp(`from\\s+["'][^"']*/${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`);
    if (re.test(source)) return true;
  }
  return false;
}

interface SymbolInfo {
  definition: string;
  isFunction: boolean;
  paramCount: number;
  isConstant: boolean;
}

function buildExportFuncRe(name: string): RegExp {
  return new RegExp(`export\\s+function\\s+${name}\\s*\\(([^)]*)\\)\\s*(?::\\s*[^{]+)?\\s*\\{`, "s");
}

function buildExportArrowRe(name: string): RegExp {
  return new RegExp(`export\\s+const\\s+${name}\\s*(?::\\s*[^=]+)?\\s*=\\s*\\(([^)]*)\\)\\s*(?::\\s*[^=]+)?\\s*=>`, "s");
}

function buildExportConstRe(name: string): RegExp {
  return new RegExp(`export\\s+const\\s+${name}\\s*(?::\\s*[^=]+)?\\s*=\\s*`);
}

function extractSymbolInfo(source: string, symbolName: string): SymbolInfo | null {
  const funcMatch = buildExportFuncRe(symbolName).exec(source);
  if (funcMatch) {
    const params = funcMatch[1].trim();
    const paramCount = params === "" ? 0 : params.split(",").length;
    const defStart = funcMatch.index;
    const definition = extractFunctionBody(source, defStart);
    return { definition, isFunction: true, paramCount, isConstant: false };
  }

  const arrowMatch = buildExportArrowRe(symbolName).exec(source);
  if (arrowMatch) {
    const params = arrowMatch[1].trim();
    const paramCount = params === "" ? 0 : params.split(",").length;
    const defStart = arrowMatch.index;
    const definition = extractUntilStatement(source, defStart);
    return { definition, isFunction: true, paramCount, isConstant: false };
  }

  const constMatch = buildExportConstRe(symbolName).exec(source);
  if (constMatch) {
    const defStart = constMatch.index;
    const definition = extractUntilStatement(source, defStart);
    const isFunc = /=>\s*/.test(definition) || /function\s*\(/.test(definition);
    return { definition, isFunction: isFunc, paramCount: 0, isConstant: !isFunc };
  }

  return null;
}

function extractFunctionBody(source: string, start: number): string {
  let depth = 0;
  let inBody = false;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") { depth++; inBody = true; }
    if (source[i] === "}") {
      depth--;
      if (inBody && depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

function extractUntilStatement(source: string, start: number): string {
  let depth = 0;
  let inString: string | null = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      if (c === inString && source[i - 1] !== "\\") inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = c; continue; }
    if (c === "{" || c === "(" || c === "[") depth++;
    if (c === "}" || c === ")" || c === "]") depth--;
    if (depth === 0 && c === ";") return source.slice(start, i + 1);
    if (depth === 0 && c === "\n" && i > start + 10) {
      const remaining = source.slice(i + 1).trimStart();
      if (/^(export|import|const|let|var|function|class|type|interface|\/\/)/.test(remaining)) {
        return source.slice(start, i);
      }
    }
  }
  return source.slice(start);
}

function resolveToCanonical(importPath: string, fromFileRel: string): string {
  if (importPath.startsWith("@/")) return importPath.slice(2);
  const parts = dirname(fromFileRel).replace(/\\/g, "/").split("/");
  for (const seg of importPath.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

async function fixDsImportsFeature(finding: DriftFinding, cwd: string, opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const domainRoots = opts?.domainRoots ?? DEFAULT_DOMAIN_ROOTS;
  const domainImports = parseDomainImports(source, domainRoots);
  if (domainImports.length === 0) {
    return { finding, fixed: false, message: `no domain imports found in ${finding.file}`, changes: [] };
  }

  let anyFixed = false;
  let currentSource = source;
  const changes: Change[] = [];

  for (const imp of domainImports) {
    const resolvedFile = await resolveImportFile(imp.importPath, finding.file, cwd);
    let sourceFileContent: string | null = null;
    if (resolvedFile) {
      try { sourceFileContent = await readFile(resolvedFile, "utf8"); } catch { /* */ }
    }

    const hasDomainDeps = sourceFileContent
      ? sourceHasDomainDeps(sourceFileContent, domainRoots)
      : false;

    for (const symbolName of imp.symbols) {
      const symbolInfo = sourceFileContent
        ? extractSymbolInfo(sourceFileContent, symbolName)
        : null;

      const canExtract = !hasDomainDeps;
      const canConvertToProp = symbolInfo !== null && (
        symbolInfo.isConstant ||
        (symbolInfo.isFunction && symbolInfo.paramCount <= 2)
      );

      let selectedOption: string;
      if (canExtract) {
        selectedOption = `Extract "${symbolName}" to design-system/utils/`;
      } else if (canConvertToProp || opts?.prompt) {
        const options: PromptOption[] = [];
        if (canConvertToProp) options.push({ label: `Convert "${symbolName}" to prop injection`, description: "Pass this value as a prop instead of importing it" });
        options.push({ label: "Defer (add exception)", description: "Skip for now and add an exception entry" });

        if (options.length === 1 || !opts?.prompt) {
          continue;
        }

        const choice = await opts.prompt(
          `"${symbolName}" comes from a domain module that can't be moved to design-system (it has its own domain dependencies). What should we do?`,
          options,
        );
        if (choice === "defer") continue;
        selectedOption = options[choice].label;
      } else {
        continue;
      }

      if (selectedOption.startsWith("Extract")) {
        const canonical = resolveToCanonical(imp.importPath, finding.file);
        const utilsFileName = basename(canonical);
        const utilsRelPath = `design-system/utils/${utilsFileName}.ts`;

        const definition = symbolInfo?.definition ?? `export { ${symbolName} } from "${imp.importPath}";\n`;
        changes.push({
          kind: "write",
          path: utilsRelPath,
          before: null,
          after: Buffer.from(definition.trimEnd() + "\n"),
        });

        const newPath = `@/design-system/utils/${utilsFileName}`;

        const importLineRe = new RegExp(
          `import\\s+\\{[^}]*\\b${symbolName}\\b[^}]*\\}\\s+from\\s+["']` +
          imp.importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          `["']\\s*;?`,
        );
        currentSource = currentSource.replace(
          importLineRe,
          `import { ${symbolName} } from "${newPath}";`,
        );

        const aliasOldPath = `@/${canonical}`;
        const importChanges = await collectProjectImportRewriteChanges(cwd, imp.importPath, newPath);
        changes.push(...importChanges);
        if (aliasOldPath !== imp.importPath) {
          const aliasChanges = await collectProjectImportRewriteChanges(cwd, aliasOldPath, newPath);
          changes.push(...aliasChanges);
        }
        anyFixed = true;

      } else if (selectedOption.startsWith("Convert")) {
        const importLineRe = new RegExp(
          `import\\s+\\{[^}]*\\b${symbolName}\\b[^}]*\\}\\s+from\\s+["']` +
          imp.importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          `["']\\s*;?\\s*\\n?`,
        );
        currentSource = currentSource.replace(importLineRe, "");

        const funcRe = /export\s+(?:default\s+)?function\s+\w+\s*\(\s*\{([^}]*)\}\s*(?::\s*\{([^}]*)\})?\s*\)/;
        const funcMatch = funcRe.exec(currentSource);
        if (funcMatch) {
          const existingProps = funcMatch[1].trim();
          const existingTypes = funcMatch[2]?.trim();
          const newProps = existingProps
            ? `${existingProps}, ${symbolName}`
            : symbolName;
          let replacement: string;
          if (existingTypes !== undefined) {
            const typeSuffix = symbolInfo?.isFunction
              ? `${symbolName}: (...args: unknown[]) => unknown`
              : `${symbolName}: unknown`;
            const newTypes = existingTypes
              ? `${existingTypes}; ${typeSuffix}`
              : typeSuffix;
            replacement = funcMatch[0]
              .replace(`{${funcMatch[1]}}`, `{${newProps}}`)
              .replace(`{${funcMatch[2]}}`, `{${newTypes}}`);
          } else {
            replacement = funcMatch[0].replace(`{${funcMatch[1]}}`, `{${newProps}}`);
          }
          currentSource = currentSource.replace(funcMatch[0], replacement);
        } else {
          const simpleFuncRe = /export\s+(?:default\s+)?function\s+\w+\s*\(\s*\)/;
          const simpleMatch = simpleFuncRe.exec(currentSource);
          if (simpleMatch) {
            currentSource = currentSource.replace(
              simpleMatch[0],
              simpleMatch[0].replace("()", `({ ${symbolName} })`),
            );
          }
        }

        anyFixed = true;
      }
    }
  }

  if (!anyFixed) {
    return { finding, fixed: false, message: `deferred domain import fixes for ${finding.file}`, changes: [] };
  }

  changes.push({
    kind: "write",
    path: finding.file,
    before: Buffer.from(source),
    after: Buffer.from(currentSource),
  });

  return { finding, fixed: true, message: `resolved domain imports in ${finding.file}`, changes };
}

// --- DRIFT-CVA-VARIANT-UNRENDERED fixer ---

function parseExercisedVariantsFromSource(source: string, axes: string[]): Map<string, Set<string>> {
  const exercised = new Map<string, Set<string>>();
  for (const axis of axes) exercised.set(axis, new Set());

  const examplesMatch = source.match(/examples\s*:\s*\[([\s\S]*?)\]\s*(?:,|\})/);
  if (!examplesMatch) return exercised;

  for (const axis of axes) {
    const re = new RegExp(`${axis}\\s*:\\s*["']([^"']+)["']`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(examplesMatch[1])) !== null) {
      exercised.get(axis)!.add(m[1]);
    }
  }
  return exercised;
}

function buildExampleStub(axis: string, value: string): string {
  return `{ name: "${value}", props: { ${axis}: "${value}" } }`;
}

async function fixCvaVariantUnrendered(finding: DriftFinding, cwd: string, _opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const cvaVariants = parseCvaVariants(source);
  if (!cvaVariants) {
    return { finding, fixed: false, message: `no CVA variants found in ${finding.file}`, changes: [] };
  }

  const axes = Object.keys(cvaVariants);
  const exercised = parseExercisedVariantsFromSource(source, axes);

  const stubs: string[] = [];
  for (const axis of axes) {
    const exercisedValues = exercised.get(axis)!;
    for (const value of cvaVariants[axis]) {
      if (!exercisedValues.has(value)) {
        stubs.push(buildExampleStub(axis, value));
      }
    }
  }

  if (stubs.length === 0) {
    return { finding, fixed: false, message: `no unexercised variants found in ${finding.file}`, changes: [] };
  }

  let result = source;

  const emptyExamplesRe = /examples\s*:\s*\[\s*\]/;
  const existingExamplesRe = /examples\s*:\s*\[([\s\S]*?)\]\s*(?:,|\})/;

  if (emptyExamplesRe.test(result)) {
    const stubList = stubs.join(",\n    ");
    result = result.replace(emptyExamplesRe, `examples: [\n    ${stubList},\n  ]`);
  } else {
    const match = existingExamplesRe.exec(result);
    if (match) {
      const existingContent = match[1].trimEnd();
      const trailingComma = existingContent.endsWith(",") ? "" : ",";
      const stubList = stubs.join(",\n    ");
      const newExamples = `examples: [${existingContent}${trailingComma}\n    ${stubList},\n  ]`;
      result = result.replace(existingExamplesRe, (full) => {
        const suffix = full.endsWith(",") ? "," : full.endsWith("}") ? "}" : "";
        return newExamples + suffix;
      });
    }
  }

  if (result === source) {
    return { finding, fixed: false, message: `could not modify examples in ${finding.file}`, changes: [] };
  }

  const changes: Change[] = [{
    kind: "write",
    path: finding.file,
    before: Buffer.from(source),
    after: Buffer.from(result),
  }];

  return {
    finding,
    fixed: true,
    message: `added ${stubs.length} meta.examples stub${stubs.length > 1 ? "s" : ""} to ${finding.file}`,
    changes,
  };
}

// Extract top-level `{...}` entries from a string by counting brace depth.
function extractBraceEntries(text: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        entries.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return entries;
}

function extractExamplesContent(source: string): string | null {
  const opener = /examples\s*:\s*\[/.exec(source);
  if (!opener) return null;
  let depth = 1;
  const start = opener.index + opener[0].length;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) return source.slice(start, i);
    }
  }
  return null;
}

// --- DRIFT-META-EXAMPLES-DUPLICATE fixer ---

async function fixMetaExamplesDuplicate(finding: DriftFinding, cwd: string, _opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const examplesContent = extractExamplesContent(source);
  if (examplesContent === null) {
    return { finding, fixed: false, message: `no examples array found in ${finding.file}`, changes: [] };
  }

  const entries = extractBraceEntries(examplesContent);

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of entries) {
    const normalized = entry.replace(/\s+/g, " ");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(entry);
    }
  }

  if (unique.length === entries.length) {
    return { finding, fixed: false, message: `no duplicates found in ${finding.file}`, changes: [] };
  }

  const opener = /examples\s*:\s*\[/.exec(source)!;
  const arrayStart = opener.index;
  let depth = 1;
  let arrayEnd = arrayStart + opener[0].length;
  for (let i = arrayEnd; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") { depth--; if (depth === 0) { arrayEnd = i + 1; break; } }
  }
  const afterBracket = source.slice(arrayEnd).match(/^\s*(?:,|\})/);
  const suffix = afterBracket ? afterBracket[0].trimStart() : "";

  const indent = "    ";
  const stubList = unique.map(e => e.trim()).join(`,\n${indent}`);
  const replacement = `examples: [\n${indent}${stubList},\n  ]${suffix}`;
  const result = source.slice(0, arrayStart) + replacement + source.slice(arrayEnd + (afterBracket?.[0].length ?? 0));

  const changes: Change[] = [{
    kind: "write",
    path: finding.file,
    before: Buffer.from(source),
    after: Buffer.from(result),
  }];

  const removed = entries.length - unique.length;
  return {
    finding,
    fixed: true,
    message: `removed ${removed} duplicate meta.examples entr${removed === 1 ? "y" : "ies"} from ${finding.file}`,
    changes,
  };
}

// --- DRIFT-META-EXAMPLES-CORRUPT fixer ---

async function fixMetaExamplesCorrupt(finding: DriftFinding, cwd: string, _opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const content = extractExamplesContent(source);
  if (content === null) {
    return { finding, fixed: false, message: `no examples array found in ${finding.file}`, changes: [] };
  }

  const lines = content.split("\n");
  const repaired: string[] = [];
  let depth = 0;

  for (const line of lines) {
    const stripped = line.trimStart();
    if (stripped.startsWith("{") && depth > 0) {
      const indent = line.slice(0, line.length - stripped.length);
      while (depth > 0) {
        repaired.push(`${indent}},`);
        depth--;
      }
    }
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    repaired.push(line);
  }

  const fixed = repaired.join("\n");
  if (fixed === content) {
    return { finding, fixed: false, message: `could not auto-repair ${finding.file}`, changes: [] };
  }

  const opener = /examples\s*:\s*\[/.exec(source)!;
  const arrayStart = opener.index;
  let bracketDepth = 1;
  let arrayEnd = arrayStart + opener[0].length;
  for (let i = arrayEnd; i < source.length; i++) {
    if (source[i] === "[") bracketDepth++;
    else if (source[i] === "]") { bracketDepth--; if (bracketDepth === 0) { arrayEnd = i + 1; break; } }
  }
  const afterBracket = source.slice(arrayEnd).match(/^\s*(?:,|\})/);
  const suffix = afterBracket ? afterBracket[0].trimStart() : "";

  const result = source.slice(0, arrayStart)
    + `examples: [\n${fixed.trimStart()}\n  ]${suffix}`
    + source.slice(arrayEnd + (afterBracket?.[0].length ?? 0));

  const changes: Change[] = [{
    kind: "write",
    path: finding.file,
    before: Buffer.from(source),
    after: Buffer.from(result),
  }];

  return {
    finding,
    fixed: true,
    message: `repaired truncated meta.examples entries in ${finding.file}`,
    changes,
  };
}

// --- DRIFT-STALE-DS-IMPORT fixer ---

const STALE_ALIAS_RE = /(from\s+["'])@\/design-system\/(.*?)(["'])/g;

async function fixStaleDsImport(finding: DriftFinding, cwd: string, opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  const canonicalAlias = (opts?.dsAliases ?? []).find(a => a !== "@/design-system") ?? "@ds";
  let result = source.replace(STALE_ALIAS_RE, `$1${canonicalAlias}/$2$3`);

  // Deduplicate identical import lines created by the rewrite
  const lines = result.split("\n");
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const isCompleteImport = trimmed.startsWith("import ") && trimmed.includes(" from ");
    if (isCompleteImport && seen.has(trimmed)) continue;
    if (isCompleteImport) seen.add(trimmed);
    deduped.push(line);
  }
  result = deduped.join("\n");

  if (result === source) {
    return { finding, fixed: false, message: `no stale imports found in ${finding.file}`, changes: [] };
  }

  const changes: Change[] = [{
    kind: "write",
    path: finding.file,
    before: Buffer.from(source),
    after: Buffer.from(result),
  }];

  return {
    finding,
    fixed: true,
    message: `rewrote stale @/design-system/ imports to ${canonicalAlias}/ in ${finding.file}`,
    changes,
  };
}

// --- DRIFT-RAW-PRIMITIVE fixer ---

const RAW_PRIMITIVE_RE_FIXER = /<(button|input)([\s>])/g;

const ELEMENT_TO_ATOM: Record<string, string> = {
  button: "button",
  input: "input",
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function kebabToPascal(s: string): string {
  return s.split("-").map(capitalize).join("");
}

interface RawElementMatch {
  element: string;
  fullMatch: string;
  index: number;
}

function findRawElements(source: string): RawElementMatch[] {
  const matches: RawElementMatch[] = [];
  RAW_PRIMITIVE_RE_FIXER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RAW_PRIMITIVE_RE_FIXER.exec(source)) !== null) {
    matches.push({ element: m[1], fullMatch: m[0], index: m.index });
  }
  return matches;
}

async function atomFileExists(cwd: string, atomName: string): Promise<string | null> {
  const candidates = [`design-system/atoms/${atomName}.tsx`, `design-system/atoms/${atomName}.ts`];
  for (const c of candidates) {
    try {
      const s = await stat(join(cwd, c));
      if (s.isFile()) return c;
    } catch { /* not found */ }
  }
  return null;
}

export function buildVariantOptions(cvaVariants: Record<string, string[]>): string[] {
  const axes = Object.entries(cvaVariants);
  if (axes.length === 0) return ["Use default"];

  const options: string[] = [];
  for (const [axis, values] of axes) {
    for (const v of values) {
      options.push(`${axis}="${v}"`);
    }
  }
  return options;
}

interface InstanceRewrite {
  element: string;
  atomComponent: string;
  variantProp: string | null;
  index: number;
}

function rewriteRawElement(
  source: string,
  element: string,
  atomComponent: string,
  variantProp: string | null,
): string {
  const openTagRe = new RegExp(
    `<${element}(\\s[^>]*)?>`,
    "g",
  );
  const closeTagRe = new RegExp(`</${element}>`, "g");

  let result = source;

  result = result.replace(openTagRe, (_match, attrs: string | undefined) => {
    let cleanAttrs = (attrs ?? "").trim();
    cleanAttrs = cleanAttrs.replace(/\bclassName\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})\s*/g, "").trim();

    const parts = [`<${atomComponent}`];
    if (variantProp) parts.push(` ${variantProp}`);
    if (cleanAttrs) parts.push(` ${cleanAttrs}`);
    return parts.join("") + ">";
  });

  result = result.replace(closeTagRe, `</${atomComponent}>`);

  const selfCloseRe = new RegExp(`<${element}(\\s[^>]*)\\s*/>`, "g");
  result = result.replace(selfCloseRe, (_match, attrs: string) => {
    let cleanAttrs = attrs.trim();
    cleanAttrs = cleanAttrs.replace(/\bclassName\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})\s*/g, "").trim();

    const parts = [`<${atomComponent}`];
    if (variantProp) parts.push(` ${variantProp}`);
    if (cleanAttrs) parts.push(` ${cleanAttrs}`);
    return parts.join("") + " />";
  });

  return result;
}

function rewriteInstances(source: string, rewrites: InstanceRewrite[]): string {
  const sorted = [...rewrites].sort((a, b) => b.index - a.index);
  let result = source;

  for (const { element, atomComponent, variantProp, index } of sorted) {
    const selfCloseRe = new RegExp(`<${element}(\\s[^>]*)\\s*/>`);
    const openTagRe = new RegExp(`<${element}(\\s[^>]*)?>`);

    const after = result.slice(index);

    const selfMatch = after.match(selfCloseRe);
    if (selfMatch && selfMatch.index === 0) {
      let cleanAttrs = (selfMatch[1] ?? "").trim();
      cleanAttrs = cleanAttrs.replace(/\bclassName\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})\s*/g, "").trim();
      const parts = [`<${atomComponent}`];
      if (variantProp) parts.push(` ${variantProp}`);
      if (cleanAttrs) parts.push(` ${cleanAttrs}`);
      result = result.slice(0, index) + parts.join("") + " />" + result.slice(index + selfMatch[0].length);
      continue;
    }

    const openMatch = after.match(openTagRe);
    if (openMatch && openMatch.index === 0) {
      let cleanAttrs = (openMatch[1] ?? "").trim();
      cleanAttrs = cleanAttrs.replace(/\bclassName\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})\s*/g, "").trim();
      const parts = [`<${atomComponent}`];
      if (variantProp) parts.push(` ${variantProp}`);
      if (cleanAttrs) parts.push(` ${cleanAttrs}`);
      let replaced = result.slice(0, index) + parts.join("") + ">" + result.slice(index + openMatch[0].length);

      const closeRe = new RegExp(`</${element}>`);
      const closeMatch = replaced.slice(index).match(closeRe);
      if (closeMatch && closeMatch.index != null) {
        const closeStart = index + closeMatch.index;
        replaced = replaced.slice(0, closeStart) + `</${atomComponent}>` + replaced.slice(closeStart + closeMatch[0].length);
      }
      result = replaced;
    }
  }

  return result;
}

function addImportIfMissing(source: string, componentName: string, importPath: string): string {
  const importRe = new RegExp(`import\\s+\\{[^}]*\\b${componentName}\\b[^}]*\\}\\s+from\\s+["']${importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
  if (importRe.test(source)) return source;

  const importLine = `import { ${componentName} } from "${importPath}";\n`;
  const firstImportMatch = source.match(/^import\s/m);
  if (firstImportMatch && firstImportMatch.index !== undefined) {
    return source.slice(0, firstImportMatch.index) + importLine + source.slice(firstImportMatch.index);
  }
  return importLine + source;
}

const NAMED_COMPONENT_START_RE = /^function\s+([A-Z][A-Za-z0-9]+)\s*\(/gm;

const LOCAL_DECL_RE = /^(?:type|interface|const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm;

interface InternalComponent {
  name: string;
  startIndex: number;
  endIndex: number;
  body: string;
}

function extractFullFunction(source: string, start: number): string {
  let parenDepth = 0;
  let braceDepth = 0;
  let foundOpenParen = false;
  let pastParams = false;
  let foundBodyOpen = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (!pastParams) {
      if (c === "(") { parenDepth++; foundOpenParen = true; }
      if (c === ")" && foundOpenParen) {
        parenDepth--;
        if (parenDepth === 0) pastParams = true;
      }
      continue;
    }
    if (c === "{") { braceDepth++; foundBodyOpen = true; }
    if (c === "}") {
      braceDepth--;
      if (foundBodyOpen && braceDepth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

function findInternalComponents(source: string): InternalComponent[] {
  const components: InternalComponent[] = [];
  NAMED_COMPONENT_START_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAMED_COMPONENT_START_RE.exec(source)) !== null) {
    const lineStart = source.lastIndexOf("\n", m.index) + 1;
    const beforeOnLine = source.slice(lineStart, m.index);
    if (/export\s+/.test(beforeOnLine)) continue;

    const funcBody = extractFullFunction(source, m.index);
    const lineCount = funcBody.split("\n").length;
    if (lineCount < 20) continue;

    components.push({
      name: m[1],
      startIndex: m.index,
      endIndex: m.index + funcBody.length,
      body: funcBody,
    });
  }
  return components;
}

function deriveAtomName(componentName: string, parentFileName: string): string {
  const parentPascal = kebabToPascal(parentFileName.replace(/\.\w+$/, ""));
  if (componentName.startsWith(parentPascal) && componentName.length > parentPascal.length) {
    return componentName.slice(parentPascal.length);
  }
  return componentName;
}

function toKebab(pascal: string): string {
  return pascal
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

function findLocalDeps(componentBody: string, source: string): { name: string; declaration: string; usedOnlyByComponent: boolean }[] {
  const deps: { name: string; declaration: string; usedOnlyByComponent: boolean }[] = [];
  LOCAL_DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOCAL_DECL_RE.exec(source)) !== null) {
    const declName = m[1];
    if (/^export\s/.test(source.slice(Math.max(0, source.lastIndexOf("\n", m.index) + 1), m.index + m[0].length))) continue;

    const nameRe = new RegExp(`\\b${declName}\\b`);
    if (!nameRe.test(componentBody)) continue;

    const declaration = extractUntilStatement(source, m.index);
    const remainingSource = source.replace(componentBody, "").replace(declaration, "");
    const usedElsewhere = nameRe.test(remainingSource);

    deps.push({
      name: declName,
      declaration,
      usedOnlyByComponent: !usedElsewhere,
    });
  }
  return deps;
}

function extractCodeContext(source: string, element: string, file: string): string {
  const lines = source.split("\n");
  const elementRe = new RegExp(`<${element}[\\s>]`);
  for (let i = 0; i < lines.length; i++) {
    if (elementRe.test(lines[i])) {
      const lineNum = i + 1;
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      const snippet = lines.slice(start, end)
        .map((l, idx) => `  ${start + idx + 1}| ${l}`)
        .join("\n");
      return `${file}:${lineNum}\n${snippet}`;
    }
  }
  return file;
}

function inferVariantForInstance(
  openTag: string,
  cvaVariants: Record<string, string[]>,
): string | null {
  const allValues = Object.entries(cvaVariants).flatMap(([axis, values]) =>
    values.map(v => ({ axis, value: v }))
  );

  const classMatch = openTag.match(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/);
  const classText = (classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? "").toLowerCase();
  if (!classText) return "default";

  // Match variant values only as standalone classes (word-bounded by whitespace),
  // not as suffixes of Tailwind utilities like "text-sm" or "bg-secondary"
  const classes = classText.split(/\s+/);
  const matchedVariants = allValues.filter(({ value }) => {
    const v = value.toLowerCase();
    return classes.some(cls => cls === v);
  });

  if (matchedVariants.length === 0) return "default";
  if (matchedVariants.length === 1) {
    const { axis, value } = matchedVariants[0];
    return `${axis}="${value}"`;
  }
  return null;
}

async function fixRawPrimitive(finding: DriftFinding, cwd: string, opts?: FixerOpts): Promise<FixResult> {
  const absPath = join(cwd, finding.file);
  let source: string;
  try {
    source = await readFile(absPath, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${finding.file}`, changes: [] };
  }

  let currentSource = source;
  let anyFixed = false;
  const changes: Change[] = [];

  // Path A: replace raw primitives with existing atoms (per-instance inference)
  const rawElements = findRawElements(currentSource);
  const uniqueElements = [...new Set(rawElements.map(m => m.element))];

  const skippedElements: string[] = [];

  for (const element of uniqueElements) {
    const atomFileName = ELEMENT_TO_ATOM[element];
    if (!atomFileName) {
      skippedElements.push(element);
      continue;
    }

    const atomPath = await atomFileExists(cwd, atomFileName);
    if (!atomPath) {
      skippedElements.push(element);
      continue;
    }

    const atomComponent = capitalize(element);
    let atomSource: string;
    try {
      atomSource = await readFile(join(cwd, atomPath), "utf8");
    } catch {
      continue;
    }

    const cvaVariants = parseCvaVariants(atomSource);

    if (!cvaVariants) {
      // No variants — auto-replace all instances
      currentSource = rewriteRawElement(currentSource, element, atomComponent, null);
      currentSource = addImportIfMissing(currentSource, atomComponent, `@/design-system/atoms/${atomFileName}`);
      anyFixed = true;
      continue;
    }

    // Per-instance: infer variant from each element's own className
    const instances = findRawElements(currentSource);
    const elementInstances = instances.filter(m => m.element === element);

    const autoRewrites: InstanceRewrite[] = [];
    const ambiguousInstances: RawElementMatch[] = [];

    for (const inst of elementInstances) {
      const openTagMatch = currentSource.slice(inst.index).match(
        new RegExp(`<${element}(\\s[^>]*)?\\/?>`)
      );
      const openTag = openTagMatch ? openTagMatch[0] : "";
      const inferred = inferVariantForInstance(openTag, cvaVariants);

      if (inferred === "default") {
        autoRewrites.push({ element, atomComponent, variantProp: null, index: inst.index });
      } else if (inferred) {
        autoRewrites.push({ element, atomComponent, variantProp: inferred, index: inst.index });
      } else {
        ambiguousInstances.push(inst);
      }
    }

    // Auto-apply unambiguous instances
    if (autoRewrites.length > 0) {
      currentSource = rewriteInstances(currentSource, autoRewrites);
      currentSource = addImportIfMissing(currentSource, atomComponent, `@/design-system/atoms/${atomFileName}`);
      anyFixed = true;
    }

    // Ambiguous instances: safe default is base atom with no variant prop
    if (ambiguousInstances.length > 0) {
      const remaining = findRawElements(currentSource).filter(m => m.element === element);
      const remainingRewrites: InstanceRewrite[] = remaining.map(inst => ({
        element,
        atomComponent,
        variantProp: null,
        index: inst.index,
      }));

      if (remainingRewrites.length > 0) {
        currentSource = rewriteInstances(currentSource, remainingRewrites);
        currentSource = addImportIfMissing(currentSource, atomComponent, `@/design-system/atoms/${atomFileName}`);
        anyFixed = true;
      }
    }
  }

  // Path B: extract internal components to new atoms
  const internalComponents = findInternalComponents(currentSource);
  const parentFileName = basename(finding.file);

  for (const comp of internalComponents) {
    const atomName = deriveAtomName(comp.name, parentFileName);
    const atomFileKebab = toKebab(atomName);
    const existingAtom = await atomFileExists(cwd, atomFileKebab);

    if (existingAtom) continue;

    // Auto-accept derived name (no prompt needed)
    let finalAtomName = atomName;

    const finalFileName = toKebab(finalAtomName);
    const localDeps = findLocalDeps(comp.body, currentSource);

    const depsToMove = localDeps.filter(d => d.usedOnlyByComponent);
    const depsToKeep = localDeps.filter(d => !d.usedOnlyByComponent);

    let atomFileContent = "";
    for (const dep of depsToMove) {
      atomFileContent += dep.declaration.trimEnd() + "\n\n";
    }
    for (const dep of depsToKeep) {
      atomFileContent += dep.declaration.trimEnd() + "\n\n";
    }

    const renamedBody = comp.body.replace(
      new RegExp(`\\b${comp.name}\\b`),
      finalAtomName,
    );
    atomFileContent += `export ${renamedBody.trimEnd()}\n`;
    atomFileContent += `\nexport const meta = { kind: "atom" as const, examples: [{ name: "default", props: {} }] };\n`;

    changes.push({
      kind: "write",
      path: `design-system/atoms/${finalFileName}.tsx`,
      before: null,
      after: Buffer.from(atomFileContent),
    });

    let updatedSource = currentSource;
    for (const dep of depsToMove) {
      updatedSource = updatedSource.replace(dep.declaration, "");
    }
    updatedSource = updatedSource.replace(comp.body, "");
    updatedSource = updatedSource.replace(/\n{3,}/g, "\n\n");

    if (comp.name !== finalAtomName) {
      updatedSource = updatedSource.replace(
        new RegExp(`<${comp.name}(\\s|>|\\/)`, "g"),
        `<${finalAtomName}$1`,
      );
      updatedSource = updatedSource.replace(
        new RegExp(`</${comp.name}>`, "g"),
        `</${finalAtomName}>`,
      );
    }

    updatedSource = addImportIfMissing(updatedSource, finalAtomName, `@/design-system/atoms/${finalFileName}`);
    currentSource = updatedSource;
    anyFixed = true;
  }

  if (!anyFixed) {
    if (skippedElements.length > 0) {
      const tags = skippedElements.map(e => `<${e}>`).join(", ");
      return { finding, fixed: false, message: `no base atom mapping for ${tags} — create the atom in design-system/atoms/ first`, changes: [] };
    }
    return { finding, fixed: false, message: `no fixable raw primitives in ${finding.file}`, changes: [] };
  }

  changes.push({
    kind: "write",
    path: finding.file,
    before: Buffer.from(source),
    after: Buffer.from(currentSource),
  });
  return { finding, fixed: true, message: `replaced raw primitives in ${finding.file}`, changes };
}
