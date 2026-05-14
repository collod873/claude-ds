export class ClassifyError extends Error {}
export type Tier = "atom" | "composite";
const ATOM_RE = /from\s+["'][^"']*design-system\/atoms\//;
const COMP_RE = /from\s+["'][^"']*design-system\/composites\//;
export function classify(source: string): Tier {
  if (COMP_RE.test(source)) throw new ClassifyError("source imports from design-system/composites — tier violation");
  if (ATOM_RE.test(source)) return "composite";
  return "atom";
}
