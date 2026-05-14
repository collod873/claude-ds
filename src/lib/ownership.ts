import type { Manifest, Category } from "./manifest.js";
export function categoryOf(m: Manifest, path: string): Category | null {
  const e = m.files.find((f) => f.path === path);
  return e ? e.category : null;
}
