import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { transformSync } from "esbuild";

const PACK_FILES = resolve("packs/next-react/files");
const PACK_ROOT = resolve("packs/next-react");

const ROUTE_FILES = [
  "app/design/page.tsx",
  "app/design/layout.tsx",
  "app/design/[...slug]/page.tsx",
  "app/design/[...slug]/resolve.ts",
  // Client component that renders the catalog grid; gates detail links on
  // `has_showcase` so showcase-less sub-parts aren't shipped as dead links.
  "app/design/_filter.tsx",
];

const REFERENCE_FILES = [
  "design-system/references/tokens.tsx",
  "design-system/references/motion.tsx",
];

describe("/design route files shipped by pack", () => {
  it.each(ROUTE_FILES)("ships %s", (rel) => {
    expect(existsSync(join(PACK_FILES, rel))).toBe(true);
  });

  it.each([...ROUTE_FILES, ...REFERENCE_FILES])("parses %s with esbuild", (rel) => {
    const src = readFileSync(join(PACK_FILES, rel), "utf8");
    const loader = rel.endsWith(".tsx") ? "tsx" : "ts";
    expect(() => transformSync(src, { loader })).not.toThrow();
  });

  it("layout enforces all three gating tiers", () => {
    const src = readFileSync(join(PACK_FILES, "app/design/layout.tsx"), "utf8");
    expect(src).toMatch(/NODE_ENV.*===.*["']production["']/);
    expect(src).toMatch(/DESIGN_GALLERY_ENABLED/);
    expect(src).toMatch(/notFound\(\)/);
  });

  it("catalog gates detail links on has_showcase so sub-parts aren't dead links", () => {
    // The [...slug] route 404s on any entry without a `.showcase.tsx`. The
    // index must therefore NOT link showcase-less sub-parts (combobox-input,
    // accordion-trigger, …). Assert the filter branches on `has_showcase`
    // and renders a non-anchor card for the showcase-less path.
    const filter = readFileSync(join(PACK_FILES, "app/design/_filter.tsx"), "utf8");
    expect(filter).toMatch(/has_showcase === false/);
    // The page must carry the flag through from the manifest for the gate to
    // see it.
    const page = readFileSync(join(PACK_FILES, "app/design/page.tsx"), "utf8");
    expect(page).toMatch(/has_showcase\?: boolean/);
  });
});

describe("no live `_design` references in pack", () => {
  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === "node_modules") continue;
        yield* walk(full);
      } else {
        yield full;
      }
    }
  }

  it("no source file in packs/next-react/files references `_design`", () => {
    const hits: string[] = [];
    for (const path of walk(PACK_FILES)) {
      const src = readFileSync(path, "utf8");
      if (/(^|[^A-Za-z0-9_])_design([^A-Za-z0-9_]|$)/.test(src)) {
        hits.push(path);
      }
    }
    expect(hits).toEqual([]);
  });

  it("tombstone for app/_design exists in pack manifest deprecated_paths", () => {
    const m = JSON.parse(readFileSync(join(PACK_ROOT, "manifest.json"), "utf8"));
    const found = (m.deprecated_paths ?? []).some((d: { path: string }) => d.path === "app/_design");
    expect(found).toBe(true);
  });
});
