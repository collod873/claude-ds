export class ConfigError extends Error {}
export interface Config {
  version: string; pack: string; mode: "warn" | "block";
  enforce_threshold: number; removed: string[];
}
const ALLOWED = new Set(["version","pack","mode","enforce_threshold","removed"]);
const VERSION_RE = /^v\d+\.\d+\.\d+$/;
export function parseConfig(raw: string): Config {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch (e) { throw new ConfigError(`invalid JSON: ${(e as Error).message}`); }
  if (typeof obj !== "object" || obj === null) throw new ConfigError("config must be an object");
  const o = obj as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!ALLOWED.has(k)) throw new ConfigError(`unknown field: ${k}`);
  if (typeof o.version !== "string" || !VERSION_RE.test(o.version)) throw new ConfigError(`version must match vX.Y.Z`);
  if (typeof o.pack !== "string" || o.pack.length === 0) throw new ConfigError(`pack required`);
  if (o.mode !== "warn" && o.mode !== "block") throw new ConfigError(`mode must be warn|block`);
  const enforce_threshold = o.enforce_threshold === undefined ? 10 : Number(o.enforce_threshold);
  if (!Number.isInteger(enforce_threshold) || enforce_threshold < 0) throw new ConfigError(`enforce_threshold must be ≥ 0 integer`);
  const removed = o.removed === undefined ? [] : o.removed;
  if (!Array.isArray(removed) || removed.some((x) => typeof x !== "string")) throw new ConfigError(`removed must be string[]`);
  return { version: o.version, pack: o.pack, mode: o.mode, enforce_threshold, removed: removed as string[] };
}
