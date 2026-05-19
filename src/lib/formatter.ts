/**
 * Formatter detection and invocation for post-sync file formatting.
 * Detects biome (biome.json / biome.jsonc) or prettier (.prettierrc*) in cwd,
 * then invokes the consumer's local formatter binary on rewritten files.
 * If the formatter exits non-zero, warns but does not fail sync.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { info } from "./log.js";

export type DetectedFormatter = "biome" | "prettier" | null;

const BIOME_CONFIGS = ["biome.json", "biome.jsonc"];
const PRETTIER_CONFIGS = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.ts",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
];

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function detectFormatter(cwd: string): Promise<DetectedFormatter> {
  for (const name of BIOME_CONFIGS) {
    if (await fileExists(join(cwd, name))) return "biome";
  }
  for (const name of PRETTIER_CONFIGS) {
    if (await fileExists(join(cwd, name))) return "prettier";
  }
  return null;
}

/**
 * Resolve the formatter binary path.
 * Checks consumer's node_modules/.bin first, then falls back to PATH.
 * Returns null if not found anywhere.
 */
async function resolveFormatterBin(name: string, cwd: string): Promise<string | null> {
  const localBin = join(cwd, "node_modules", ".bin", name);
  if (await fileExists(localBin)) return localBin;
  // Fall back to PATH — useful when formatter is globally installed or in tests
  const which = spawnSync("which", [name], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

/**
 * Run the detected formatter against the provided file paths.
 * biome: `<formatter> check --write <files...>`
 * prettier: `<formatter> --write <files...>`
 * Warns (does not throw) on non-zero exit or when binary is not found.
 */
export async function runFormatter(
  formatter: DetectedFormatter,
  files: string[],
  cwd: string
): Promise<void> {
  if (!formatter || files.length === 0) return;

  const bin = await resolveFormatterBin(formatter, cwd);
  if (!bin) {
    info(`warn: ${formatter} config detected but binary not found — skipping auto-format`);
    return;
  }

  const args =
    formatter === "biome"
      ? ["check", "--write", ...files]
      : ["--write", ...files];

  info(`running formatter: ${bin} ${args.slice(0, 2).join(" ")} <${files.length} file(s)>`);

  const r = spawnSync(bin, args, { cwd, encoding: "utf8" });

  if (r.status !== 0) {
    const detail = (r.stderr ?? r.stdout ?? "").trim();
    info(`warn: formatter exited ${r.status}${detail ? ` — ${detail}` : ""} (sync still applied)`);
  }
}
