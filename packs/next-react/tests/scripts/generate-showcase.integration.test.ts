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

  it("generates index page with component link when manifest has one component", async () => {
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

    const indexPath = join(dir, "app", "_design", "page.tsx");
    expect(existsSync(indexPath)).toBe(true);

    const indexContent = readFileSync(indexPath, "utf8");
    // Must reference the component name
    expect(indexContent).toContain("Button");
    // Must link to /_design/Button
    expect(indexContent).toContain("_design/Button");
    // Must link to tokens and motion
    expect(indexContent).toContain("_design/tokens");
    expect(indexContent).toContain("_design/motion");
  });

  it("generates per-component page importing .tsx and .showcase.tsx when has_showcase=true", async () => {
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

    const compPath = join(dir, "app", "_design", "Badge", "page.tsx");
    expect(existsSync(compPath)).toBe(true);

    const content = readFileSync(compPath, "utf8");
    // Imports component
    expect(content).toContain("Badge");
    // Imports showcase (has_showcase=true)
    expect(content).toContain(".showcase");
    // Imports states (has_states=true)
    expect(content).toContain(".states.json");
    // Renders <Badge />
    expect(content).toContain("<Badge");
  });

  it("generates per-component page WITHOUT showcase import when has_showcase=false", async () => {
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
      join(dir, "app", "_design", "Chip", "page.tsx"),
      "utf8"
    );
    expect(content).not.toContain(".showcase");
    expect(content).not.toContain(".states.json");
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

    const tokensPagePath = join(dir, "app", "_design", "tokens", "page.tsx");
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

    const motionPagePath = join(dir, "app", "_design", "motion", "page.tsx");
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

    expect(existsSync(join(dir, "app", "_design", "tokens", "page.tsx"))).toBe(true);
    expect(existsSync(join(dir, "app", "_design", "motion", "page.tsx"))).toBe(true);
  });

  // Issue #17 — kebab-case component names must produce valid TS identifiers
  it("converts kebab-case component name to PascalCase in import/export identifiers", async () => {
    // File paths stay kebab-case; only identifier bindings must be PascalCase
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

    const compPath = join(dir, "app", "_design", "icon-button", "page.tsx");
    expect(existsSync(compPath)).toBe(true);

    const content = readFileSync(compPath, "utf8");

    // Import binding must be PascalCase, not kebab-case.
    // Component uses named export ({ Foo }); showcase uses default export.
    expect(content).toContain("import { IconButton } from");
    expect(content).toContain("import IconButtonShowcase from");
    // JSX tags must use PascalCase
    expect(content).toContain("<IconButton");
    expect(content).toContain("<IconButtonShowcase");
    // Export function name must be PascalCase (valid TS identifier)
    expect(content).toMatch(/export default function IconButton/);
    // Must NOT use raw kebab-case as an identifier
    expect(content).not.toMatch(/import icon-button/);
    expect(content).not.toMatch(/<icon-button/);
  });

  it("generates all four required routes (index + tokens + motion + component)", async () => {
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

    expect(existsSync(join(dir, "app", "_design", "page.tsx"))).toBe(true);
    expect(existsSync(join(dir, "app", "_design", "Avatar", "page.tsx"))).toBe(true);
    expect(existsSync(join(dir, "app", "_design", "tokens", "page.tsx"))).toBe(true);
    expect(existsSync(join(dir, "app", "_design", "motion", "page.tsx"))).toBe(true);
  });
});
