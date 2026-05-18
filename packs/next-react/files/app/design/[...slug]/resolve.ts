/**
 * Pure slug → manifest-entry resolver for the /design catch-all route.
 * Lives outside the page so it can be unit-tested without the Next runtime.
 */

export interface ManifestEntry {
  name: string;
  tier: string;
  kind?: "atom" | "composite" | "reference";
  path: string;
  path_no_ext: string;
  has_showcase: boolean;
  has_states: boolean;
  has_test: boolean;
}

export interface Manifest {
  generated: string;
  components: ManifestEntry[];
}

const SECTION_TO_KIND: Record<string, ManifestEntry["kind"]> = {
  atoms: "atom",
  composites: "composite",
  references: "reference",
};

const SECTION_TO_DIR: Record<string, string> = {
  atoms: "atoms",
  composites: "composites",
  references: "references",
};

/**
 * Resolve a URL slug like ["atoms", "button"] to a manifest entry.
 * Returns null on any mismatch (unknown section, name not found, kind disagreement).
 */
export function resolve(slug: string[], manifest: Manifest): ManifestEntry | null {
  if (!slug || slug.length !== 2) return null;
  const [section, name] = slug;

  const expectedKind = SECTION_TO_KIND[section];
  const dir = SECTION_TO_DIR[section];
  if (!expectedKind || !dir) return null;

  const entry = manifest.components.find((c) => c.name === name);
  if (!entry) return null;

  if (entry.kind && entry.kind !== expectedKind) return null;
  if (!entry.path_no_ext.startsWith(`design-system/${dir}/`)) return null;

  return entry;
}
