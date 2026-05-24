import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";

const PACK_CONFIG_PATH = resolve(
  import.meta.dirname ?? new URL(import.meta.url).pathname.replace(/\/[^/]+$/, ""),
  "../../packs/next-react/files/tailwind.config.cjs",
);

const PACK_TOKENS_PATH = resolve(
  import.meta.dirname ?? new URL(import.meta.url).pathname.replace(/\/[^/]+$/, ""),
  "../../packs/next-react/files/design-system/tokens.json",
);

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await freshTmpDir("tw-plugin-");
  await mkdir(join(tmpDir, "design-system"), { recursive: true });
});
afterEach(async () => { await cleanup(tmpDir); });

async function loadConfig(tokens: object): Promise<Record<string, unknown>> {
  await writeFile(join(tmpDir, "design-system/tokens.json"), JSON.stringify(tokens, null, 2) + "\n");
  const configDest = join(tmpDir, "tailwind.config.cjs");
  await copyFile(PACK_CONFIG_PATH, configDest);
  // Clear require cache so each test gets a fresh load
  const req = createRequire(configDest);
  // Bust cache entries for this config and the tokens file it requires
  const tokensKey = join(tmpDir, "design-system/tokens.json");
  delete (req as unknown as { cache: Record<string, unknown> }).cache?.[configDest];
  delete (req as unknown as { cache: Record<string, unknown> }).cache?.[tokensKey];
  return req(configDest) as Record<string, unknown>;
}

const defaultTokens = {
  color: { primary: "#0070f3", background: "#ffffff", foreground: "#111111" },
  motion: {
    duration: { fast: "150ms", base: "250ms", slow: "400ms" },
    ease: {
      "in": "cubic-bezier(0.4, 0, 1, 1)",
      "out": "cubic-bezier(0, 0, 0.2, 1)",
      "in-out": "cubic-bezier(0.4, 0, 0.2, 1)",
    },
  },
  shadow: {
    sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
    lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    popover: "0 4px 16px 0 rgb(0 0 0 / 0.12)",
  },
  z: { base: 0, dropdown: 1000, sticky: 1100, modal: 1300, popover: 1400, toast: 1500 },
  mask: {
    "fade-to-bottom": "linear-gradient(to bottom, black, transparent)",
    "fade-to-top": "linear-gradient(to top, black, transparent)",
    "fade-edges": "linear-gradient(to right, transparent, black 20%, black 80%, transparent)",
  },
};

describe("tailwind.config.cjs — ds theme extension", () => {
  it("resolves duration-* from motion.duration tokens", async () => {
    const config = await loadConfig(defaultTokens);
    const extend = (config.theme as Record<string, unknown>).extend as Record<string, unknown>;
    const duration = extend.transitionDuration as Record<string, string>;
    expect(duration.base).toBe("250ms");
    expect(duration.fast).toBe("150ms");
    expect(duration.slow).toBe("400ms");
  });

  it("resolves ease-* from motion.ease tokens", async () => {
    const config = await loadConfig(defaultTokens);
    const extend = (config.theme as Record<string, unknown>).extend as Record<string, unknown>;
    const ease = extend.transitionTimingFunction as Record<string, string>;
    expect(ease["out"]).toBe("cubic-bezier(0, 0, 0.2, 1)");
    expect(ease["in"]).toBe("cubic-bezier(0.4, 0, 1, 1)");
    expect(ease["in-out"]).toBe("cubic-bezier(0.4, 0, 0.2, 1)");
  });

  it("resolves shadow-* from shadow tokens", async () => {
    const config = await loadConfig(defaultTokens);
    const extend = (config.theme as Record<string, unknown>).extend as Record<string, unknown>;
    const shadow = extend.boxShadow as Record<string, string>;
    expect(shadow.sm).toBe("0 1px 2px 0 rgb(0 0 0 / 0.05)");
    expect(shadow.popover).toBe("0 4px 16px 0 rgb(0 0 0 / 0.12)");
  });

  it("resolves z-* from z tokens", async () => {
    const config = await loadConfig(defaultTokens);
    const extend = (config.theme as Record<string, unknown>).extend as Record<string, unknown>;
    const z = extend.zIndex as Record<string, string>;
    expect(z.dropdown).toBe("1000");
    expect(z.modal).toBe("1300");
    expect(z.base).toBe("0");
  });

  it("includes mask plugin in plugins array", async () => {
    const config = await loadConfig(defaultTokens);
    const plugins = config.plugins as unknown[];
    expect(plugins.length).toBeGreaterThan(0);
    // Invoke the mask plugin with a spy to verify it adds .mask-* utilities
    const added: Record<string, Record<string, string>> = {};
    const mockApi = { addUtilities: (utilities: Record<string, Record<string, string>>) => Object.assign(added, utilities) };
    for (const plugin of plugins) {
      if (typeof plugin === "function") plugin(mockApi);
    }
    expect(added[".mask-fade-to-bottom"]).toBeDefined();
    expect(added[".mask-fade-to-bottom"]["mask-image"]).toBe("linear-gradient(to bottom, black, transparent)");
    expect(added[".mask-fade-edges"]).toBeDefined();
  });

  it("gracefully handles missing token groups (empty objects)", async () => {
    const config = await loadConfig({ color: { primary: "#fff" } });
    const extend = (config.theme as Record<string, unknown>).extend as Record<string, unknown>;
    expect(extend.transitionDuration).toEqual({});
    expect(extend.transitionTimingFunction).toEqual({});
    expect(extend.boxShadow).toEqual({});
    expect(extend.zIndex).toEqual({});
  });
});
