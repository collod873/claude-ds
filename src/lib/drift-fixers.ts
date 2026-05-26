import { readFile, writeFile, readdir, rename, mkdir, stat } from "node:fs/promises";
import { join, basename, dirname, extname, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { DriftFinding, DriftRuleId } from "./drift-rules.js";
import type { Tier } from "./classifier.js";
import { classifySource, DEFAULT_DOMAIN_ROOTS } from "./classifier.js";
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
  "DRIFT-DS-IMPORTS-FEATURE": { fixer: fixDsImportsFeature, interactive: true },
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

async function rewriteProjectImports(
  cwd: string,
  oldImportPath: string,
  newImportPath: string,
): Promise<void> {
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
        await writeFile(full, content.split(oldImportPath).join(newImportPath), "utf8");
      }
    }
  }
  await walk(cwd);
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
    return { finding, fixed: false, message: `could not read ${finding.file}` };
  }

  if (!opts?.prompt) {
    return { finding, fixed: false, message: `DRIFT-DS-IMPORTS-FEATURE requires interactive prompt` };
  }

  const domainRoots = opts.domainRoots ?? DEFAULT_DOMAIN_ROOTS;
  const domainImports = parseDomainImports(source, domainRoots);
  if (domainImports.length === 0) {
    return { finding, fixed: false, message: `no domain imports found in ${finding.file}` };
  }

  let anyFixed = false;
  let currentSource = source;

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

      const options: string[] = [];
      if (canExtract) options.push(`Extract "${symbolName}" to design-system/utils/`);
      if (canConvertToProp) options.push(`Convert "${symbolName}" to prop injection`);
      options.push("Defer (add exception)");

      if (options.length === 1) {
        continue;
      }

      const choice = await opts.prompt(
        `${finding.file}: "${symbolName}" imported from domain root`,
        options,
      );

      if (choice === "defer") continue;

      const selectedOption = options[choice];

      if (selectedOption.startsWith("Extract")) {
        const canonical = resolveToCanonical(imp.importPath, finding.file);
        const utilsFileName = basename(canonical);
        const utilsDir = join(cwd, "design-system/utils");
        await mkdir(utilsDir, { recursive: true });

        const definition = symbolInfo?.definition ?? `export { ${symbolName} } from "${imp.importPath}";\n`;
        await writeFile(join(utilsDir, `${utilsFileName}.ts`), definition.trimEnd() + "\n", "utf8");

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

        await writeFile(absPath, currentSource, "utf8");
        // Rewrite both the relative form and the @/ alias form project-wide
        const aliasOldPath = `@/${canonical}`;
        await rewriteProjectImports(cwd, imp.importPath, newPath);
        if (aliasOldPath !== imp.importPath) {
          await rewriteProjectImports(cwd, aliasOldPath, newPath);
        }
        currentSource = await readFile(absPath, "utf8");
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

        await writeFile(absPath, currentSource, "utf8");
        anyFixed = true;
      }
    }
  }

  if (!anyFixed) {
    return { finding, fixed: false, message: `deferred domain import fixes for ${finding.file}` };
  }

  return { finding, fixed: true, message: `resolved domain imports in ${finding.file}` };
}
