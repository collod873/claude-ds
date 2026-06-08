/**
 * `mergeMetaKind` — the A1 deep module (PRD #407 / issue #409).
 *
 * Locates an existing `export const meta` declaration (typed `: Meta`,
 * `as const`, single- or multi-line) and injects `kind: "<tier>" as const`
 * into the existing object literal when `kind` is absent — preserving the
 * existing `examples` / `role` fields and the original formatting. Only
 * emits a fresh declaration when the file genuinely carries no
 * `export const meta`.
 *
 * Hard guarantee: a single input never yields two top-level
 * `export const meta` in the output. That is the property the previous
 * append-only fixer broke and the property a Crewops-shaped consumer
 * tree silently depends on.
 *
 * Out of scope: a pre-existing meta whose `kind` *conflicts* with the
 * tier. That is a different rule (kind-vs-location mismatch) and is
 * handled elsewhere — this module only backfills a *missing* `kind`.
 */
import type { Tier } from "../classifier.js";

const META_DECL_RE = /\bexport\s+const\s+meta\s*(?::\s*[^=]+?)?=\s*\{/;

/**
 * Merge `kind: "<tier>" as const` into the existing meta declaration in
 * `source`, or emit a fresh one if no `export const meta` is present.
 *
 * Pure function — no I/O.
 */
export function mergeMetaKind(source: string, tier: Tier): string {
  const m = META_DECL_RE.exec(source);
  if (!m) return appendFreshMeta(source, tier);

  const openBraceIdx = m.index + m[0].length - 1;
  const closeBraceIdx = findMatchingBrace(source, openBraceIdx);
  // Malformed source — bail rather than risk producing nonsense.
  if (closeBraceIdx === -1) return source;

  const body = source.slice(openBraceIdx + 1, closeBraceIdx);
  if (hasTopLevelKey(body, "kind")) return source;

  const before = source.slice(0, openBraceIdx + 1);
  const after = source.slice(closeBraceIdx);

  // Empty object → render the kind compactly inside the existing `{}`.
  if (body.trim() === "") {
    return before + ` kind: "${tier}" as const ` + after;
  }

  if (body.includes("\n")) {
    // Multiline: match the indent of the first existing field.
    const indent = detectFieldIndent(body);
    const insertion = `\n${indent}kind: "${tier}" as const,`;
    return before + insertion + body + after;
  }

  // Single-line: drop the kind in just after the opening brace, normalising
  // the gap between `{` and the first field to a single space so the output
  // reads cleanly regardless of the input's leading whitespace.
  const trimmedBody = body.replace(/^[ \t]+/, "");
  return before + ` kind: "${tier}" as const, ` + trimmedBody + after;
}

function appendFreshMeta(source: string, tier: Tier): string {
  const metaExport = `\nexport const meta = { kind: "${tier}" as const, examples: [] };\n`;
  return source.trimEnd() + "\n" + metaExport;
}

/**
 * Walk from `openIdx` (which must point at `{`) and return the index of the
 * matching `}` — respecting nested braces, strings, template literals, and
 * comments. Returns `-1` when the source is unbalanced (malformed).
 */
function findMatchingBrace(source: string, openIdx: number): number {
  let depth = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : "";
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i++; // skip the escaped char
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Does the object body declare `key:` at top-level (depth 0)? Respects
 * nested objects, arrays, strings, template literals, and comments so a
 * `kind` token buried inside `examples: [{ props: { kind: "x" } }]` is not
 * confused for the top-level field.
 */
function hasTopLevelKey(body: string, key: string): boolean {
  let depth = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const next = i + 1 < body.length ? body[i + 1] : "";
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      continue;
    }
    if (depth === 0 && /[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < body.length && /[\w$]/.test(body[j])) j++;
      const ident = body.slice(i, j);
      if (ident === key) {
        let k = j;
        while (k < body.length && /\s/.test(body[k])) k++;
        if (body[k] === ":") return true;
      }
      i = j - 1; // -1 because the loop will i++ next
    }
  }
  return false;
}

/**
 * Pick an indent for the injected `kind:` line by sampling the first
 * non-blank line inside the existing object body. Falls back to two spaces
 * when the body has no precedent (e.g. only a trailing comment).
 */
function detectFieldIndent(body: string): string {
  const m = body.match(/\n([ \t]+)\S/);
  return m ? m[1] : "  ";
}
