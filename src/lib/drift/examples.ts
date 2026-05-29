/**
 * Find the content between `examples: [` and its matching `]`, handling
 * nested brackets. Returns null if no examples array is found.
 *
 * Shared by the META-EXAMPLES-DUPLICATE detect+fix, META-EXAMPLES-CORRUPT
 * detect+fix, and CVA-VARIANT-UNRENDERED detect.
 */
export function extractExamplesContent(source: string): string | null {
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

/**
 * Extract top-level `{...}` entries from a string by counting brace depth.
 * Used to walk the contents of a `meta.examples` array entry-by-entry.
 */
export function extractBraceEntries(text: string): string[] {
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
