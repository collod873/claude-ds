/**
 * Merges two JSON strings, replacing only the owned top-level keys from upstream
 * into current. All other top-level keys from current are preserved unchanged.
 * Keys in upstream that are not in ownedKeys are ignored.
 *
 * @param upstream - JSON string from the pack/upstream source
 * @param current  - JSON string currently on disk
 * @param ownedKeys - top-level keys that the CLI owns; upstream value replaces current wholesale
 * @returns Formatted JSON string (2-space indent, trailing newline)
 */
export function mergeJsonKeys(upstream: string, current: string, ownedKeys: string[]): string {
  let upstreamObj: Record<string, unknown>;
  let currentObj: Record<string, unknown>;

  try {
    upstreamObj = JSON.parse(upstream);
  } catch {
    throw new Error("upstream JSON is malformed");
  }

  try {
    currentObj = JSON.parse(current);
  } catch {
    throw new Error("current JSON is malformed");
  }

  const merged: Record<string, unknown> = { ...currentObj };

  for (const key of ownedKeys) {
    if (Object.prototype.hasOwnProperty.call(upstreamObj, key)) {
      merged[key] = upstreamObj[key];
    }
  }

  return JSON.stringify(merged, null, 2) + "\n";
}
