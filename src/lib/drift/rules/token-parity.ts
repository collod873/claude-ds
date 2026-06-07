import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { Change } from "../../operation.js";
import type { ProjectContext } from "../../project.js";

import type {
  DriftFinding,
  DriftRule,
  DriftRuleInput,
  FixResult,
} from "../rule.js";

/**
 * DRIFT-TOKEN-PARITY — `design-system/tokens.json` vs. the consumer's emitted
 * CSS variables (commonly `app/globals.css`).
 *
 * tokens.json is the only sanctioned source of truth (writes go through
 * `scripts/update-tokens.ts`); the CSS side is a derived view. When the two
 * disagree — a token has no `--name` declaration, a `--name` has no token, or
 * the values differ — the consumer's components and Tailwind theme can resolve
 * a different value than the showcase reads, which is exactly the failure mode
 * the consumer's hand-rolled `lint-tokens.ts` script guards. Until this rule
 * shipped, OWNED-TOKEN-LINT could not legitimately claim supersession
 * (ADR-0017 addendum, PRD #340).
 *
 * Asymmetric fix: JSON-missing-from-CSS is auto-added (write into the existing
 * `:root` block, or append one when none exists). CSS-extra-not-in-JSON is
 * preserved — the consumer may be mid-rename or may want to keep a derived
 * variable — and reported in the remediation message instead of silently
 * deleted. Value mismatches are rewritten toward the JSON value (the source
 * of truth contract makes this safe).
 */

export const TOKENS_PATH = "design-system/tokens.json";

const DEFAULT_CSS_CANDIDATES = ["app/globals.css", "src/app/globals.css", "styles/globals.css"];

// `:root` is the canonical token-declaration block. `.dark { --x: y }`-style
// theme overrides live in other selectors and are deliberate variations, not
// the source-of-truth value — both parsing and rewriting are confined to
// `:root` so the rule does not flag overrides as drift or silently rewrite
// them when --fix runs.
const ROOT_BLOCK_RE = /(:root\s*\{)([\s\S]*?)(\})/;
const ROOT_BLOCK_RE_G = /(:root\s*\{)([\s\S]*?)(\})/g;
const CSS_VAR_DECL_RE_G = /--([a-zA-Z_][\w-]*)\s*:\s*([^;]+);/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function flattenTokens(obj: JsonValue, prefix: string[] = [], out: Record<string, string> = {}): Record<string, string> {
  if (obj === null || obj === undefined) return out;
  if (typeof obj !== "object" || Array.isArray(obj)) {
    if (prefix.length === 0) return out;
    out[prefix.join("-")] = String(obj);
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, JsonValue>)) {
    flattenTokens(v, [...prefix, k], out);
  }
  return out;
}

function parseTokensJson(source: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return flattenTokens(parsed as JsonValue);
}

/** Extract `--name: value;` declarations from `:root` blocks in CSS source.
 *  Theme-override blocks (`.dark { --x: y }`, `:root[data-theme=light]`, etc.)
 *  are intentionally skipped — they are variations, not the canonical token
 *  value, and treating them as drift would corrupt the consumer's theming. */
export function parseCssVariables(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const blockRe = new RegExp(ROOT_BLOCK_RE_G.source, "g");
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(source)) !== null) {
    const body = bm[2];
    const declRe = new RegExp(CSS_VAR_DECL_RE_G.source, "g");
    let dm: RegExpExecArray | null;
    while ((dm = declRe.exec(body)) !== null) {
      out[dm[1]] = dm[2].trim();
    }
  }
  return out;
}

interface ParityDiff {
  missingInCss: { name: string; value: string }[];
  extraInCss: { name: string; value: string }[];
  valueMismatch: { name: string; jsonValue: string; cssValue: string }[];
}

function diffParity(
  jsonTokens: Record<string, string>,
  cssVars: Record<string, string>,
): ParityDiff {
  const missingInCss: ParityDiff["missingInCss"] = [];
  const extraInCss: ParityDiff["extraInCss"] = [];
  const valueMismatch: ParityDiff["valueMismatch"] = [];

  for (const [name, value] of Object.entries(jsonTokens)) {
    const cssValue = cssVars[name];
    if (cssValue === undefined) {
      missingInCss.push({ name, value });
    } else if (cssValue !== value) {
      valueMismatch.push({ name, jsonValue: value, cssValue });
    }
  }
  for (const [name, value] of Object.entries(cssVars)) {
    if (!(name in jsonTokens)) {
      extraInCss.push({ name, value });
    }
  }

  return { missingInCss, extraInCss, valueMismatch };
}

function isClean(diff: ParityDiff): boolean {
  return diff.missingInCss.length === 0
    && diff.extraInCss.length === 0
    && diff.valueMismatch.length === 0;
}

function summarizeDiff(diff: ParityDiff, cssFile: string): string {
  const parts: string[] = [];
  if (diff.missingInCss.length > 0) {
    const names = diff.missingInCss.map(t => `--${t.name}`).join(", ");
    parts.push(`${diff.missingInCss.length} token${diff.missingInCss.length === 1 ? "" : "s"} missing from ${cssFile}: ${names}`);
  }
  if (diff.valueMismatch.length > 0) {
    const examples = diff.valueMismatch.slice(0, 3)
      .map(m => `--${m.name} (json=${m.jsonValue} css=${m.cssValue})`)
      .join(", ");
    parts.push(`${diff.valueMismatch.length} value mismatch${diff.valueMismatch.length === 1 ? "" : "es"}: ${examples}`);
  }
  if (diff.extraInCss.length > 0) {
    const names = diff.extraInCss.map(t => `--${t.name}`).join(", ");
    parts.push(`${diff.extraInCss.length} CSS variable${diff.extraInCss.length === 1 ? "" : "s"} not in tokens.json: ${names}`);
  }
  return parts.join("; ");
}

function detect(input: DriftRuleInput): DriftFinding | null {
  const { file, source, cssVariables, cssVariablesFile } = input;
  if (file !== TOKENS_PATH) return null;
  if (source === undefined) return null;
  if (cssVariables === undefined) return null;

  const jsonTokens = parseTokensJson(source);
  if (jsonTokens === null) return null;

  const diff = diffParity(jsonTokens, cssVariables);
  if (isClean(diff)) return null;

  const cssFile = cssVariablesFile ?? "app/globals.css";
  return {
    ruleId: "DRIFT-TOKEN-PARITY",
    file,
    message: `tokens.json ↔ ${cssFile} parity drift — ${summarizeDiff(diff, cssFile)}`,
  };
}

async function findCssFile(cwd: string): Promise<string | null> {
  for (const candidate of DEFAULT_CSS_CANDIDATES) {
    try {
      const s = await stat(join(cwd, candidate));
      if (s.isFile()) return candidate;
    } catch { /* not present */ }
  }
  return null;
}

function renderDeclaration(name: string, value: string): string {
  return `  --${name}: ${value};`;
}

function appendDeclarationsToRoot(css: string, additions: { name: string; value: string }[]): string {
  if (additions.length === 0) return css;
  const newLines = additions.map(a => renderDeclaration(a.name, a.value)).join("\n") + "\n";

  const m = ROOT_BLOCK_RE.exec(css);
  if (m && m.index !== undefined) {
    const head = m[1];
    const body = m[2];
    const close = m[3];
    const trimmedBody = body.replace(/\s*$/, "");
    const sep = trimmedBody.length === 0 ? "\n" : "\n";
    const newBlock = `${head}${trimmedBody}${sep}${newLines}${close}`;
    return css.slice(0, m.index) + newBlock + css.slice(m.index + m[0].length);
  }

  const block = `:root {\n${newLines}}\n`;
  return css.length === 0 || css.endsWith("\n") ? css + block : css + "\n" + block;
}

function rewriteDeclarationValues(css: string, mismatches: { name: string; jsonValue: string }[]): string {
  // Confine rewrites to `:root` blocks so theme overrides (`.dark { --x: y }`
  // and friends) keep their distinct values. Without this scope, a value
  // mismatch on `--color-primary` would also overwrite `.dark`'s override and
  // silently break the consumer's dark mode.
  return css.replace(ROOT_BLOCK_RE_G, (_, head: string, body: string, close: string) => {
    let next = body;
    for (const { name, jsonValue } of mismatches) {
      const re = new RegExp(`(--${escapeRegex(name)}\\s*:\\s*)([^;]+)(;)`, "g");
      next = next.replace(re, `$1${jsonValue}$3`);
    }
    return `${head}${next}${close}`;
  });
}

async function fix(finding: DriftFinding, ctx: ProjectContext): Promise<FixResult> {
  const tokensAbs = join(ctx.cwd, TOKENS_PATH);
  let tokensSource: string;
  try {
    tokensSource = await readFile(tokensAbs, "utf8");
  } catch {
    return { finding, fixed: false, message: `could not read ${TOKENS_PATH} — run \`claude-ds sync\` to restore`, changes: [] };
  }

  const jsonTokens = parseTokensJson(tokensSource);
  if (jsonTokens === null) {
    return { finding, fixed: false, message: `${TOKENS_PATH} is not valid JSON — fix manually before re-running`, changes: [] };
  }

  const cssFile = await findCssFile(ctx.cwd);
  if (cssFile === null) {
    const list = DEFAULT_CSS_CANDIDATES.map(c => `  - ${c}`).join("\n");
    return {
      finding,
      fixed: false,
      message: `no globals.css found at any known location — create one of:\n${list}\nthen re-run audit --fix`,
      changes: [],
    };
  }

  const cssAbs = join(ctx.cwd, cssFile);
  const cssSource = await readFile(cssAbs, "utf8");
  const cssVars = parseCssVariables(cssSource);
  const diff = diffParity(jsonTokens, cssVars);

  if (isClean(diff)) {
    return { finding, fixed: false, message: `${TOKENS_PATH} already in parity with ${cssFile}`, changes: [] };
  }

  let next = cssSource;
  if (diff.valueMismatch.length > 0) {
    next = rewriteDeclarationValues(next, diff.valueMismatch);
  }
  if (diff.missingInCss.length > 0) {
    next = appendDeclarationsToRoot(next, diff.missingInCss);
  }

  const fixedSomething = diff.missingInCss.length > 0 || diff.valueMismatch.length > 0;
  const hasStale = diff.extraInCss.length > 0;

  if (!fixedSomething) {
    // Only stale variables remain — fix can't safely delete them.
    const names = diff.extraInCss.map(t => `--${t.name}`).join(", ");
    return {
      finding,
      fixed: false,
      message: `${cssFile} declares CSS variables not in ${TOKENS_PATH}: ${names} — either add the matching tokens (via \`node scripts/update-tokens.ts --set ...\`) or remove the stale variables manually`,
      changes: [],
    };
  }

  if (next === cssSource) {
    return { finding, fixed: false, message: `no changes produced for ${cssFile}`, changes: [] };
  }

  const changes: Change[] = [{
    kind: "write",
    path: cssFile,
    before: Buffer.from(cssSource),
    after: Buffer.from(next),
  }];

  const summary: string[] = [];
  if (diff.missingInCss.length > 0) {
    summary.push(`added ${diff.missingInCss.length} missing CSS variable${diff.missingInCss.length === 1 ? "" : "s"}`);
  }
  if (diff.valueMismatch.length > 0) {
    summary.push(`updated ${diff.valueMismatch.length} mismatched value${diff.valueMismatch.length === 1 ? "" : "s"} to match ${TOKENS_PATH}`);
  }
  let message = `${summary.join(" + ")} in ${cssFile}`;
  if (hasStale) {
    const names = diff.extraInCss.map(t => `--${t.name}`).join(", ");
    message += `; ${diff.extraInCss.length} stale CSS variable${diff.extraInCss.length === 1 ? "" : "s"} left in place (not in tokens.json): ${names}`;
  }
  return { finding, fixed: true, message, changes };
}

export const tokenParityRule: DriftRule = {
  id: "DRIFT-TOKEN-PARITY",
  severity: "error",
  description: "tokens.json and the consumer's emitted CSS variables disagree on tokens — JSON is the source of truth",
  detect,
  fixable: true,
  fix,
  priority: 4,
  interactive: false,
};
