import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { detectPackageManager, runCmd } from "../../src/lib/package-manager.js";

async function fresh(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "pm-detect-"));
}

describe("detectPackageManager", () => {
  let dir: string;

  beforeEach(async () => { dir = await fresh(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("returns 'pnpm' when pnpm-lock.yaml present", async () => {
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'");
    expect(await detectPackageManager(dir)).toBe("pnpm");
  });

  it("returns 'yarn' when yarn.lock present", async () => {
    await writeFile(join(dir, "yarn.lock"), "# yarn lockfile v1");
    expect(await detectPackageManager(dir)).toBe("yarn");
  });

  it("returns 'bun' when bun.lockb present", async () => {
    await writeFile(join(dir, "bun.lockb"), "");
    expect(await detectPackageManager(dir)).toBe("bun");
  });

  it("returns 'npm' when package-lock.json present and no other lockfile", async () => {
    await writeFile(join(dir, "package-lock.json"), "{}");
    expect(await detectPackageManager(dir)).toBe("npm");
  });

  it("returns 'pnpm' when both pnpm-lock.yaml and package-lock.json are present (pnpm wins)", async () => {
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'");
    await writeFile(join(dir, "package-lock.json"), "{}");
    expect(await detectPackageManager(dir)).toBe("pnpm");
  });
});

describe("runCmd", () => {
  it("yarn omits 'run': runCmd('yarn', 'test') === 'yarn test'", () => {
    expect(runCmd("yarn", "test")).toBe("yarn test");
  });

  it("pnpm includes 'run': runCmd('pnpm', 'test') === 'pnpm run test'", () => {
    expect(runCmd("pnpm", "test")).toBe("pnpm run test");
  });
});
