import { parseConfig } from "../lib/config.js";
import { parseLsRemote } from "../lib/tags.js";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

async function readIfExistsLocal(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function versionCmd(opts: { offline?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  const raw = await readIfExistsLocal(join(cwd, ".claude-ds.json"));
  const installed = raw ? parseConfig(raw).version : "(none)";
  let latest = "unknown";
  if (!opts.offline) {
    const r = spawnSync("git", ["ls-remote","--tags","https://github.com/collod873/claude-ds"], { encoding: "utf8" });
    if (r.status === 0) { const tags = parseLsRemote(r.stdout); latest = tags[tags.length - 1] ?? "unknown"; }
  }
  console.log(`installed: ${installed}`);
  console.log(`latest: ${latest}`);
}
