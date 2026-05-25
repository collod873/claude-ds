import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectDsAliases } from "../../src/lib/ds-aliases";

describe("detectDsAliases", () => {
  let tmp: string;

  async function setup() {
    tmp = await mkdtemp(join(tmpdir(), "ds-aliases-"));
  }

  async function teardown() {
    await rm(tmp, { recursive: true, force: true });
  }

  it("detects @ds from root tsconfig.json paths", async () => {
    await setup();
    try {
      await writeFile(join(tmp, "tsconfig.json"), JSON.stringify({
        compilerOptions: { paths: { "@ds/*": ["./design-system/*"] } },
      }));
      const aliases = await detectDsAliases(tmp, "src");
      expect(aliases).toEqual(["@ds"]);
    } finally {
      await teardown();
    }
  });

  it("detects @ds from srcRoot tsconfig.json", async () => {
    await setup();
    try {
      await mkdir(join(tmp, "src"), { recursive: true });
      await writeFile(join(tmp, "src", "tsconfig.json"), JSON.stringify({
        compilerOptions: { paths: { "@ds/*": ["../design-system/*"] } },
      }));
      const aliases = await detectDsAliases(tmp, "src");
      expect(aliases).toEqual(["@ds"]);
    } finally {
      await teardown();
    }
  });

  it("prefers srcRoot tsconfig over root tsconfig", async () => {
    await setup();
    try {
      await mkdir(join(tmp, "src"), { recursive: true });
      await writeFile(join(tmp, "src", "tsconfig.json"), JSON.stringify({
        compilerOptions: { paths: { "@ds/*": ["../design-system/*"] } },
      }));
      await writeFile(join(tmp, "tsconfig.json"), JSON.stringify({
        compilerOptions: { paths: { "@design/*": ["./design-system/*"] } },
      }));
      const aliases = await detectDsAliases(tmp, "src");
      expect(aliases).toEqual(["@ds"]);
    } finally {
      await teardown();
    }
  });

  it("returns [] when no tsconfig exists", async () => {
    await setup();
    try {
      const aliases = await detectDsAliases(tmp, "src");
      expect(aliases).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it("returns [] when tsconfig has no paths", async () => {
    await setup();
    try {
      await writeFile(join(tmp, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2020" },
      }));
      const aliases = await detectDsAliases(tmp, "src");
      expect(aliases).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it("returns [] when paths don't point to design-system", async () => {
    await setup();
    try {
      await writeFile(join(tmp, "tsconfig.json"), JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./src/*"] } },
      }));
      const aliases = await detectDsAliases(tmp, "src");
      expect(aliases).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it("skips unparseable tsconfig (comments)", async () => {
    await setup();
    try {
      await writeFile(join(tmp, "tsconfig.json"), `{
  // this is a comment
  "compilerOptions": { "paths": { "@ds/*": ["./design-system/*"] } }
}`);
      const aliases = await detectDsAliases(tmp, "src");
      expect(aliases).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it("detects multiple aliases", async () => {
    await setup();
    try {
      await writeFile(join(tmp, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
          paths: {
            "@ds/*": ["./design-system/*"],
            "@design/*": ["./design-system/*"],
            "@/*": ["./src/*"],
          },
        },
      }));
      const aliases = await detectDsAliases(tmp, "src");
      expect(aliases).toEqual(["@ds", "@design"]);
    } finally {
      await teardown();
    }
  });

  it("filters out empty prefix from bare /* path key", async () => {
    await setup();
    try {
      await writeFile(join(tmp, "tsconfig.json"), JSON.stringify({
        compilerOptions: { paths: { "/*": ["./design-system/*"] } },
      }));
      const aliases = await detectDsAliases(tmp, "src");
      expect(aliases).toEqual([]);
    } finally {
      await teardown();
    }
  });
});
