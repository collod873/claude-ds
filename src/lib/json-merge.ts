/**
 * Namespace prefix that identifies hooks owned by claude-ds.
 * Any hook whose `command` field starts with this prefix is managed by the pack.
 * Everything else is user-owned and must never be touched.
 */
const CLAUDE_DS_HOOK_NAMESPACE = ".claude/hooks/";

/**
 * Patterns that identify pack-owned script keys.
 * A script key is "pack-owned" if its name starts with one of these prefixes
 * OR matches one of the exact names in this list.
 *
 * NOTE: The ds:, ci: namespaces are wholly owned by the pack. If a user writes
 * ds:custom and it is not present in the upstream pack, it will be stripped.
 * This is intentional — the pack owns the namespace, not individual keys.
 */
const PACK_OWNED_SCRIPT_PATTERNS: (string | RegExp)[] = [
  /^ds:/,
  /^ci:/,
  "generate:showcase",
  "lint:commits",
];

/**
 * Returns true if a script key is owned by the pack.
 */
function isPackOwnedScript(key: string): boolean {
  for (const pattern of PACK_OWNED_SCRIPT_PATTERNS) {
    if (typeof pattern === "string") {
      if (key === pattern) return true;
    } else {
      if (pattern.test(key)) return true;
    }
  }
  return false;
}

/**
 * Namespace-aware merge of two `scripts` objects.
 *
 * Algorithm:
 * 1. Start with current.scripts as base.
 * 2. Remove any keys from base that match pack-owned patterns (idempotency — stale pack scripts stripped).
 * 3. Add every key from upstream.scripts into base.
 * 4. User-named scripts (anything not matching pack-owned patterns) survive untouched.
 */
function mergeScripts(
  upstreamScripts: Record<string, unknown>,
  currentScripts: Record<string, unknown>
): Record<string, unknown> {
  // Step 1+2: start with current, strip pack-owned keys
  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(currentScripts)) {
    if (!isPackOwnedScript(key)) {
      base[key] = value;
    }
  }
  // Step 3: add all upstream (pack) scripts
  for (const [key, value] of Object.entries(upstreamScripts)) {
    base[key] = value;
  }
  return base;
}

/**
 * Represents a single inner hook entry (the objects inside a matcher's `hooks[]` array).
 */
interface HookEntry {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

/**
 * Represents one matcher block inside a hooks event array.
 */
interface MatcherBlock {
  matcher: string;
  hooks: HookEntry[];
  [key: string]: unknown;
}

/**
 * Returns true if a HookEntry is owned by claude-ds (command starts with the namespace prefix).
 */
function isPackOwned(entry: HookEntry): boolean {
  return typeof entry.command === "string" && entry.command.startsWith(CLAUDE_DS_HOOK_NAMESPACE);
}

/**
 * Namespace-aware merge of two `hooks` objects.
 *
 * claude-ds owns only hooks whose `command` starts with `.claude/hooks/`.
 * All other hooks are user-owned and must survive the merge untouched.
 *
 * Algorithm:
 * 1. Deep-clone current.hooks as the base.
 * 2. Strip claude-ds-owned inner hook entries from the base (so stale pack hooks don't accumulate).
 *    Drop empty matcher blocks and empty event keys after stripping.
 * 3. Merge upstream.hooks into the base:
 *    - For each event in upstream, for each matcher entry:
 *      - If a block with the same `matcher` already exists in base, append upstream inner hooks
 *        (deduplicating by command).
 *      - Otherwise append the whole matcher block.
 *    - If the event key doesn't exist in base, create it.
 */
function mergeHooks(
  upstreamHooks: Record<string, unknown>,
  currentHooks: Record<string, unknown>
): Record<string, unknown> {
  // Step 1: deep-clone current
  const base: Record<string, MatcherBlock[]> = {};
  for (const [event, value] of Object.entries(currentHooks)) {
    if (!Array.isArray(value)) continue; // skip non-array event values
    // Step 2: strip pack-owned entries, preserve user-owned
    const stripped: MatcherBlock[] = [];
    for (const block of value as MatcherBlock[]) {
      if (!block || typeof block !== "object" || !Array.isArray(block.hooks)) {
        // Not a well-formed matcher block — pass through unchanged
        stripped.push(block);
        continue;
      }
      const userHooks = block.hooks.filter((h) => !isPackOwned(h));
      if (userHooks.length > 0) {
        stripped.push({ ...block, hooks: userHooks });
      }
      // If all hooks were pack-owned and are now gone, drop the block entirely
    }
    if (stripped.length > 0) {
      base[event] = stripped;
    }
    // If stripped is empty, drop the event key
  }

  // Step 3: merge upstream hooks into base
  for (const [event, value] of Object.entries(upstreamHooks)) {
    if (!Array.isArray(value)) continue;
    if (!base[event]) {
      base[event] = [];
    }
    for (const upstreamBlock of value as MatcherBlock[]) {
      if (!upstreamBlock || typeof upstreamBlock !== "object") continue;
      const existingIdx = base[event].findIndex((b) => b.matcher === upstreamBlock.matcher);
      if (existingIdx >= 0) {
        // Append upstream inner hooks, deduplicating by command
        const existing = base[event][existingIdx];
        const existingCommands = new Set(existing.hooks.map((h) => h.command));
        const toAdd = Array.isArray(upstreamBlock.hooks)
          ? upstreamBlock.hooks.filter((h) => !existingCommands.has(h.command))
          : [];
        base[event][existingIdx] = { ...existing, hooks: [...existing.hooks, ...toAdd] };
      } else {
        base[event].push(upstreamBlock);
      }
    }
    // Drop event if it ended up empty
    if (base[event].length === 0) {
      delete base[event];
    }
  }

  return base;
}

export function extractScriptPath(command: string): string {
  return command.split(/\s+/)[0];
}

export function pruneHooksJson(
  current: string,
  shouldPrune: (scriptPath: string) => boolean,
  indent: number | string = 2,
): string | null {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(current); } catch { return null; }

  const hooks = obj.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return null;

  let changed = false;
  const pruned: Record<string, unknown> = {};

  for (const [event, blocks] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(blocks)) { pruned[event] = blocks; continue; }
    const kept: MatcherBlock[] = [];
    for (const block of blocks as MatcherBlock[]) {
      if (!block || typeof block !== "object" || !Array.isArray(block.hooks)) {
        kept.push(block);
        continue;
      }
      const keptHooks: HookEntry[] = [];
      for (const entry of block.hooks) {
        if (isPackOwned(entry) && shouldPrune(extractScriptPath(entry.command!))) {
          changed = true;
        } else {
          keptHooks.push(entry);
        }
      }
      if (keptHooks.length > 0) {
        kept.push({ ...block, hooks: keptHooks });
      } else if (keptHooks.length < block.hooks.length) {
        changed = true;
      }
    }
    if (kept.length > 0) {
      pruned[event] = kept;
    }
  }

  if (!changed) return null;
  return JSON.stringify({ ...obj, hooks: pruned }, null, indent) + "\n";
}

/**
 * Merges two JSON strings, with special namespace-aware handling for the `hooks` key.
 *
 * For `hooks`: applies the namespace-aware merge — claude-ds owns only hooks whose
 * `command` starts with `.claude/hooks/`. User hooks are preserved unchanged across merges.
 *
 * For any other owned key: upstream value replaces current wholesale (original behavior).
 *
 * Keys in upstream that are not in ownedKeys are ignored. All other top-level keys
 * from current are preserved unchanged.
 *
 * @param upstream  - JSON string from the pack/upstream source
 * @param current   - JSON string currently on disk
 * @param ownedKeys - top-level keys the CLI manages; `hooks` gets special treatment
 * @returns Formatted JSON string (2-space indent, trailing newline)
 */
export function mergeJsonKeys(upstream: string, current: string, ownedKeys: string[], indent: number | string = 2): string {
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
    if (key === "hooks") {
      // Namespace-aware merge: user hooks survive, pack hooks are idempotently applied
      const upstreamHooks = (upstreamObj["hooks"] ?? {}) as Record<string, unknown>;
      const currentHooks = (currentObj["hooks"] ?? {}) as Record<string, unknown>;
      merged["hooks"] = mergeHooks(upstreamHooks, currentHooks);
    } else if (key === "scripts") {
      // Namespace-aware merge: user scripts survive, pack-owned namespace is idempotently applied
      const upstreamScripts = (upstreamObj["scripts"] ?? {}) as Record<string, unknown>;
      const currentScripts = (currentObj["scripts"] ?? {}) as Record<string, unknown>;
      merged["scripts"] = mergeScripts(upstreamScripts, currentScripts);
    } else {
      // Wholesale replace for all other owned keys
      if (Object.prototype.hasOwnProperty.call(upstreamObj, key)) {
        merged[key] = upstreamObj[key];
      }
    }
  }

  return JSON.stringify(merged, null, indent) + "\n";
}
