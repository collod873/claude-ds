import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const SCRIPT = resolve("packs/next-react/files/scripts/generate-showcase.ts");

async function fresh(): Promise<string> {
  return mkdtemp(join(tmpdir(), "int-gen-showcase-"));
}

/** Write a minimal but complete component bundle into the fixture. */
async function seedBundle(
  dir: string,
  name: string,
  tier: "atoms" | "composites" = "atoms"
): Promise<void> {
  const dsDir = join(dir, "design-system", tier);
  await mkdir(dsDir, { recursive: true });
  await writeFile(
    join(dsDir, `${name}.tsx`),
    `export function ${name}() { return null; }\nexport default ${name};\n`
  );
  await writeFile(
    join(dsDir, `${name}.showcase.tsx`),
    `export default function ${name}Showcase() { return null; }\n`
  );
  await writeFile(
    join(dsDir, `${name}.states.json`),
    JSON.stringify([{ label: "default", props: {} }], null, 2)
  );
}

/** Write a manifest.json referencing the bundle. */
async function writeManifest(
  dir: string,
  components: Array<{
    name: string;
    tier: string;
    path: string;
    has_showcase: boolean;
    has_states: boolean;
    has_snapshot: boolean;
    has_test: boolean;
  }>
): Promise<void> {
  const manifestPath = join(dir, "design-system", "manifest.json");
  await mkdir(join(dir, "design-system"), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({ generated: new Date().toISOString(), components }, null, 2)
  );
}

describe("generate-showcase.ts [integration]", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fresh();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("exits 1 with SHOWCASE-000 when manifest.json is missing", () => {
    // No design-system directory at all
    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SHOWCASE-000/);
  });

  // #36: output must be app/design/ (no underscore) — underscore-prefixed folders are excluded
  // from Next.js App Router routing entirely.
  it("generates index page at app/design/ (no underscore)", async () => {
    await seedBundle(dir, "Button");
    await writeManifest(dir, [
      {
        name: "Button",
        tier: "atom",
        path: "design-system/atoms/Button.tsx",
        has_showcase: true,
        has_states: true,
        has_snapshot: false,
        has_test: false,
      },
    ]);

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });

    expect(r.status).toBe(0);

    // Must write to app/design/ — NOT app/_design/
    const indexPath = join(dir, "app", "design", "page.tsx");
    expect(existsSync(indexPath)).toBe(true);
    expect(existsSync(join(dir, "app", "_design", "page.tsx"))).toBe(false);

    const indexContent = readFileSync(indexPath, "utf8");
    // Must reference the component name
    expect(indexContent).toContain("Button");
    // Must link to /design/Button — NOT /_design/Button
    expect(indexContent).toContain("/design/Button");
    expect(indexContent).not.toContain("/_design/");
    // Must link to tokens and motion
    expect(indexContent).toContain("/design/tokens");
    expect(indexContent).toContain("/design/motion");
  });

  // #36: layout.tsx must call notFound() when NODE_ENV === 'production'
  it("generates layout.tsx that calls notFound() in production", async () => {
    await writeManifest(dir, []);

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const layoutPath = join(dir, "app", "design", "layout.tsx");
    expect(existsSync(layoutPath)).toBe(true);

    const content = readFileSync(layoutPath, "utf8");
    // Must import notFound from next/navigation
    expect(content).toContain("notFound");
    expect(content).toContain("next/navigation");
    // Must guard on NODE_ENV === 'production'
    expect(content).toContain('NODE_ENV');
    expect(content).toContain('"production"');
  });

  // #25: dynamic route instead of per-component static pages
  it("generates single dynamic [component] route — no per-component static files", async () => {
    await seedBundle(dir, "Badge");
    await writeManifest(dir, [
      {
        name: "Badge",
        tier: "atom",
        path: "design-system/atoms/Badge.tsx",
        has_showcase: true,
        has_states: true,
        has_snapshot: false,
        has_test: false,
      },
    ]);

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    // Dynamic route exists
    const dynamicPath = join(dir, "app", "design", "[component]", "page.tsx");
    expect(existsSync(dynamicPath)).toBe(true);

    // No per-component static page
    expect(existsSync(join(dir, "app", "design", "Badge", "page.tsx"))).toBe(false);

    const content = readFileSync(dynamicPath, "utf8");
    // Must export generateStaticParams
    expect(content).toContain("generateStaticParams");
    // Must reference the component name in the switch/params
    expect(content).toContain("Badge");
    // Must import showcase and states for Badge
    expect(content).toContain(".showcase");
    expect(content).toContain(".states.json");
  });

  // #25: generateStaticParams must list every component in the manifest
  it("generateStaticParams in dynamic route lists all manifest components", async () => {
    await seedBundle(dir, "Card");
    await seedBundle(dir, "Alert");
    await writeManifest(dir, [
      {
        name: "Card",
        tier: "atom",
        path: "design-system/atoms/Card.tsx",
        has_showcase: true,
        has_states: false,
        has_snapshot: false,
        has_test: false,
      },
      {
        name: "Alert",
        tier: "composite",
        path: "design-system/composites/Alert.tsx",
        has_showcase: false,
        has_states: false,
        has_snapshot: false,
        has_test: false,
      },
    ]);

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const content = readFileSync(
      join(dir, "app", "design", "[component]", "page.tsx"),
      "utf8"
    );
    // generateStaticParams must enumerate both components
    expect(content).toContain('"Card"');
    expect(content).toContain('"Alert"');
    // Both should appear in generateStaticParams section
    expect(content).toMatch(/generateStaticParams[\s\S]*Card[\s\S]*Alert/);
  });

  // #25: exactly 5 files emitted (layout + index + dynamic + tokens + motion)
  // no per-component files regardless of manifest size
  it("emits exactly 5 files for a manifest with N components", async () => {
    await seedBundle(dir, "Foo");
    await seedBundle(dir, "Bar");
    await seedBundle(dir, "Baz");
    await writeManifest(dir, [
      { name: "Foo", tier: "atom", path: "design-system/atoms/Foo.tsx", has_showcase: true, has_states: true, has_snapshot: false, has_test: false },
      { name: "Bar", tier: "atom", path: "design-system/atoms/Bar.tsx", has_showcase: true, has_states: false, has_snapshot: false, has_test: false },
      { name: "Baz", tier: "composite", path: "design-system/composites/Baz.tsx", has_showcase: false, has_states: false, has_snapshot: false, has_test: false },
    ]);

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const designDir = join(dir, "app", "design");
    // The 5 expected files
    expect(existsSync(join(designDir, "layout.tsx"))).toBe(true);
    expect(existsSync(join(designDir, "page.tsx"))).toBe(true);
    expect(existsSync(join(designDir, "[component]", "page.tsx"))).toBe(true);
    expect(existsSync(join(designDir, "tokens", "page.tsx"))).toBe(true);
    expect(existsSync(join(designDir, "motion", "page.tsx"))).toBe(true);

    // No per-component static routes
    expect(existsSync(join(designDir, "Foo", "page.tsx"))).toBe(false);
    expect(existsSync(join(designDir, "Bar", "page.tsx"))).toBe(false);
    expect(existsSync(join(designDir, "Baz", "page.tsx"))).toBe(false);
  });

  it("dynamic route handles has_showcase=false gracefully (no import)", async () => {
    await seedBundle(dir, "Chip");
    await writeManifest(dir, [
      {
        name: "Chip",
        tier: "atom",
        path: "design-system/atoms/Chip.tsx",
        has_showcase: false,
        has_states: false,
        has_snapshot: false,
        has_test: false,
      },
    ]);

    spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });

    const content = readFileSync(
      join(dir, "app", "design", "[component]", "page.tsx"),
      "utf8"
    );
    // Chip case: no showcase import, fallback to null
    expect(content).toContain("Chip");
    // When no showcase, should use a null component fallback
    expect(content).toContain("() => null");
  });

  it("generates tokens page from design-system/tokens.json", async () => {
    await writeManifest(dir, []);
    const tokensPath = join(dir, "design-system", "tokens.json");
    const tokens = {
      color: { primary: "#3b82f6", secondary: "#8b5cf6" },
      spacing: { sm: "0.5rem", md: "1rem" },
    };
    await writeFile(tokensPath, JSON.stringify(tokens, null, 2));

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const tokensPagePath = join(dir, "app", "design", "tokens", "page.tsx");
    expect(existsSync(tokensPagePath)).toBe(true);

    const content = readFileSync(tokensPagePath, "utf8");
    // Should inline the token data
    expect(content).toContain("primary");
    expect(content).toContain("#3b82f6");
    // Should have a table
    expect(content).toContain("TokensPage");
  });

  it("generates motion page referencing motion-related tokens", async () => {
    await writeManifest(dir, []);
    const tokensPath = join(dir, "design-system", "tokens.json");
    const tokens = {
      color: { primary: "#3b82f6" },
      motion: {
        duration: { fast: "150ms", slow: "300ms" },
        easing: { default: "ease-in-out" },
      },
    };
    await writeFile(tokensPath, JSON.stringify(tokens, null, 2));

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const motionPagePath = join(dir, "app", "design", "motion", "page.tsx");
    expect(existsSync(motionPagePath)).toBe(true);

    const content = readFileSync(motionPagePath, "utf8");
    expect(content).toContain("MotionPage");
    // Motion tokens baked in
    expect(content).toContain("150ms");
    expect(content).toContain("ease-in-out");
  });

  it("generates tokens and motion pages even when tokens.json is absent", async () => {
    await writeManifest(dir, []);
    // No tokens.json — generator should still succeed

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    expect(existsSync(join(dir, "app", "design", "tokens", "page.tsx"))).toBe(true);
    expect(existsSync(join(dir, "app", "design", "motion", "page.tsx"))).toBe(true);
  });

  // Issue #17 — kebab-case component names must produce valid TS identifiers in dynamic route
  it("converts kebab-case component name to PascalCase in generateStaticParams and case block", async () => {
    const tier = "atoms" as const;
    const dsDir = join(dir, "design-system", tier);
    await mkdir(dsDir, { recursive: true });
    await writeFile(
      join(dsDir, "icon-button.tsx"),
      `export function IconButton() { return null; }\nexport default IconButton;\n`
    );
    await writeFile(
      join(dsDir, "icon-button.showcase.tsx"),
      `export default function IconButtonShowcase() { return null; }\n`
    );
    await writeFile(
      join(dsDir, "icon-button.states.json"),
      JSON.stringify([{ label: "default", props: {} }], null, 2)
    );
    await writeManifest(dir, [
      {
        name: "icon-button",
        tier: "atom",
        path: "design-system/atoms/icon-button.tsx",
        has_showcase: true,
        has_states: true,
        has_snapshot: false,
        has_test: false,
      },
    ]);

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    // Dynamic route exists (not a per-component static file)
    const dynamicPath = join(dir, "app", "design", "[component]", "page.tsx");
    expect(existsSync(dynamicPath)).toBe(true);
    expect(existsSync(join(dir, "app", "design", "icon-button", "page.tsx"))).toBe(false);

    const content = readFileSync(dynamicPath, "utf8");

    // Component name appears in generateStaticParams
    expect(content).toContain('"icon-button"');
    // Showcase import references the showcase file for this component
    expect(content).toContain("icon-button.showcase");
    // Must NOT use raw kebab-case as a JS identifier
    expect(content).not.toMatch(/import icon-button/);
  });

  // #36 + #25: comprehensive: all 5 files emitted, all reference /design/ not /_design/
  it("generates all five required files — layout, index, dynamic, tokens, motion", async () => {
    await seedBundle(dir, "Avatar");
    await writeManifest(dir, [
      {
        name: "Avatar",
        tier: "atom",
        path: "design-system/atoms/Avatar.tsx",
        has_showcase: false,
        has_states: false,
        has_snapshot: false,
        has_test: false,
      },
    ]);

    const r = spawnSync("node", ["--experimental-strip-types", SCRIPT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    // The 5 expected files — all under app/design/ (no underscore)
    expect(existsSync(join(dir, "app", "design", "layout.tsx"))).toBe(true);        // #36
    expect(existsSync(join(dir, "app", "design", "page.tsx"))).toBe(true);          // index
    expect(existsSync(join(dir, "app", "design", "[component]", "page.tsx"))).toBe(true); // #25 dynamic
    expect(existsSync(join(dir, "app", "design", "tokens", "page.tsx"))).toBe(true);
    expect(existsSync(join(dir, "app", "design", "motion", "page.tsx"))).toBe(true);

    // No old underscore-prefixed paths
    expect(existsSync(join(dir, "app", "_design", "page.tsx"))).toBe(false);
    // No static per-component route
    expect(existsSync(join(dir, "app", "design", "Avatar", "page.tsx"))).toBe(false);
  });
});
