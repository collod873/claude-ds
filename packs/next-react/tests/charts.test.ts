import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, transformSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PACK_FILES = resolve("packs/next-react/files");
const PACK_ROOT = resolve("packs/next-react");
const CHARTS = join(PACK_FILES, "design-system/charts");
const TOKENS = join(PACK_FILES, "design-system/tokens.json");

const RAMP = join(CHARTS, "ramp.ts");
const PRESET = join(CHARTS, "tremor-preset.ts");
const INDEX = join(CHARTS, "index.ts");
const DEMO = resolve("packs/next-react/tests/fixtures/charts-demo/CategoryBarChart.tsx");

// TOK-001's own pattern: raw hex / rgb() / rgba() / hsl().
const RAW_COLOR =
  /["']#[0-9a-fA-F]{3,8}["']|[^a-zA-Z](rgb|rgba|hsl)\([^)]+\)/;

/** Bundle a pack module (resolving its `@/design-system/*` aliases against the
 *  real shipped files) and import the executed ESM — proves the module runs,
 *  not just parses. */
async function loadModule(entry: string, outName: string, tmp: string): Promise<Record<string, unknown>> {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    write: false,
    platform: "node",
    alias: {
      "@/design-system/tokens.json": TOKENS,
      "@/design-system/charts/ramp": RAMP,
    },
    loader: { ".json": "json" },
  });
  const file = join(tmp, outName);
  writeFileSync(file, out.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

describe("token-bound chart ramp", () => {
  it("tokens.json ships a token-derived chart palette (categorical ramp + status encodings)", () => {
    const tokens = JSON.parse(readFileSync(TOKENS, "utf8"));
    const chart = tokens.color?.chart;
    expect(chart, "color.chart must exist in the token surface").toBeDefined();

    const categorical = chart.categorical as Record<string, string>;
    expect(Object.keys(categorical).length).toBeGreaterThanOrEqual(4);
    for (const v of Object.values(categorical)) expect(v).toMatch(/^#[0-9a-fA-F]{3,8}$/);

    const status = chart.status as Record<string, string>;
    // Semantic-where-meaning-exists: status encodings carry meaning.
    expect(Object.keys(status).length).toBeGreaterThanOrEqual(3);
    for (const v of Object.values(status)) expect(v).toMatch(/^#[0-9a-fA-F]{3,8}$/);
  });

  it("ramp.ts derives from tokens.json, carries no raw color literal, and is tremor-free", () => {
    const src = readFileSync(RAMP, "utf8");
    expect(() => transformSync(src, { loader: "ts" })).not.toThrow();
    expect(src).toMatch(/tokens\.json/);
    expect(src).not.toMatch(RAW_COLOR); // criteria #1
    expect(src).not.toMatch(/from\s+["'][^"']*tremor/); // criteria #3: ramp imports no chart lib
  });

  it("tremor-preset.ts feeds the ramp through with no raw color literal", () => {
    const src = readFileSync(PRESET, "utf8");
    expect(() => transformSync(src, { loader: "ts" })).not.toThrow();
    expect(src).toMatch(/ramp/); // derives from the ramp, not parallel hex
    expect(src).not.toMatch(RAW_COLOR);
  });

  it("index.ts re-exports the ramp and the preset", () => {
    const src = readFileSync(INDEX, "utf8");
    expect(() => transformSync(src, { loader: "ts" })).not.toThrow();
    expect(src).toMatch(/ramp/);
    expect(src).toMatch(/tremor-preset/);
  });
});

describe("chart ramp — executed", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "charts-exec-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ramp exposes the token categorical values, in order, consumable without tremor", async () => {
    const tokens = JSON.parse(readFileSync(TOKENS, "utf8"));
    const expected = Object.keys(tokens.color.chart.categorical)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => tokens.color.chart.categorical[k]);

    const ramp = await loadModule(RAMP, "ramp.mjs", tmp);
    expect(ramp.categoricalRamp).toEqual(expected);
    expect((ramp.seriesColor as (i: number) => string)(0)).toBe(expected[0]);
    // wraps past the end of the ramp
    expect((ramp.seriesColor as (i: number) => string)(expected.length)).toBe(expected[0]);
    expect((ramp.statusColor as (s: string) => string)("positive")).toBe(
      tokens.color.chart.status.positive,
    );
  });

  it("tremor preset routes category names to ramp colors through tremor's color-input surface", async () => {
    const tokens = JSON.parse(readFileSync(TOKENS, "utf8"));
    const ramp = Object.keys(tokens.color.chart.categorical)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => tokens.color.chart.categorical[k]);

    const preset = await loadModule(PRESET, "preset.mjs", tmp);
    // the `colors` prop value
    expect(preset.chartColors).toEqual(ramp);
    // category -> color mapping
    const map = (preset.categoryColors as (c: string[]) => Record<string, string>)([
      "revenue",
      "expenses",
    ]);
    expect(map).toEqual({ revenue: ramp[0], expenses: ramp[1] });
    // sized colors array wraps the ramp
    expect((preset.chartColorsFor as (n: number) => string[])(2)).toEqual([ramp[0], ramp[1]]);
  });
});

describe("chart ramp — hook + fixture (no chart color literals reach app code)", () => {
  function runTokenHook(file: string) {
    const input = JSON.stringify({ tool_name: "Write", tool_input: { file_path: file } });
    const r = spawnSync(
      "bash",
      [resolve("packs/next-react/files/.claude/hooks/pre-write-ds-tokens.sh")],
      { encoding: "utf8", input },
    );
    return { code: r.status ?? 1, stderr: r.stderr };
  }

  it("the token hook (TOK-001) accepts every shipped chart module", () => {
    for (const f of [RAMP, PRESET, INDEX]) {
      const r = runTokenHook(f);
      expect(r.code, `${f}: ${r.stderr}`).toBe(0);
    }
  });

  it("the representative tremor chart fixture routes all colors through the preset", () => {
    const src = readFileSync(DEMO, "utf8");
    // parses as TSX (tremor import need not resolve to parse)
    expect(() => transformSync(src, { loader: "tsx" })).not.toThrow();
    // colors come from the preset, not literals — criteria #2
    expect(src).toMatch(/charts/);
    expect(src).not.toMatch(RAW_COLOR);
    // no bare tremor color-name literals in a `colors=` either
    expect(src).toMatch(/colors=\{/);
  });
});

describe("chart ramp — manifest + docs", () => {
  it("manifest declares the chart modules as managed so fixes reach consumers", async () => {
    const m = JSON.parse(await readFile(join(PACK_ROOT, "manifest.json"), "utf8"));
    const byPath = (p: string) => m.files.find((f: { path: string }) => f.path === p);
    for (const p of [
      "design-system/charts/ramp.ts",
      "design-system/charts/tremor-preset.ts",
      "design-system/charts/index.ts",
    ]) {
      expect(byPath(p), `${p} missing from manifest`).toBeDefined();
      expect(byPath(p).category).toBe("managed");
    }
  });

  it("contracts.md states charts must take colors from the DS ramp", async () => {
    const doc = await readFile(join(PACK_FILES, "design-system/contracts.md"), "utf8");
    expect(doc.toLowerCase()).toMatch(/chart/);
    expect(doc.toLowerCase()).toMatch(/ramp/);
  });
});
