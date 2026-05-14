export class ManifestError extends Error {}
export type Category = "managed" | "seeded" | "generated" | "hybrid";
export type Format = "markdown" | "shell" | "json";
export interface ManifestEntry { path: string; category: Category; format?: Format; }
export interface Manifest { files: ManifestEntry[]; canonical_paths: string[]; }
const CATS = new Set<Category>(["managed","seeded","generated","hybrid"]);
const FMTS = new Set<Format>(["markdown","shell","json"]);
export function parseManifest(raw: string): Manifest {
  const o = JSON.parse(raw) as { files?: unknown; canonical_paths?: unknown };
  if (!Array.isArray(o.files)) throw new ManifestError("files: array required");
  const out: ManifestEntry[] = [];
  for (const e of o.files as Record<string, unknown>[]) {
    if (typeof e.path !== "string") throw new ManifestError("entry.path: string required");
    if (!CATS.has(e.category as Category)) throw new ManifestError(`entry.category invalid: ${e.category}`);
    if (e.category === "hybrid") {
      if (!FMTS.has(e.format as Format)) throw new ManifestError(`hybrid entry missing/invalid format: ${e.path}`);
    }
    out.push({ path: e.path, category: e.category as Category, format: e.format as Format | undefined });
  }
  const canonical_paths: string[] = Array.isArray(o.canonical_paths)
    ? (o.canonical_paths as unknown[]).filter((p): p is string => typeof p === "string")
    : [];
  return { files: out, canonical_paths };
}
