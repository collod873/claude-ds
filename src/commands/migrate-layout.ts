import { readFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { parseManifest } from "../lib/manifest.js";
import { detectLookalikes } from "../lib/lookalike.js";
import { info, err, confirm } from "../lib/log.js";

const execFile = promisify(execFileCb);

export async function migrateLayoutCmd(opts: {
  pack: string;
  yes?: boolean;
  ignore?: string;
  cwd?: string;
}) {
  const cwd = opts.cwd ?? process.cwd();

  // Refuse if not inside a git repo
  try {
    await execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  } catch {
    process.stderr.write("migrate-layout: not inside a git repo\n");
    process.exit(2);
  }

  // Refuse if working tree is dirty
  const { stdout: porcelain } = await execFile("git", ["status", "--porcelain"], { cwd });
  if (porcelain.trim().length > 0) {
    process.stderr.write(
      "migrate-layout: working tree is dirty — commit or stash changes first\n"
    );
    process.exit(2);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const packDir = join(repoRoot, "packs", opts.pack);
  const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));

  const flagGlobs = opts.ignore
    ? opts.ignore
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean)
    : [];
  const ignoreGlobs = [...manifest.lookalike_ignore, ...flagGlobs];

  const findings = await detectLookalikes(cwd, manifest.canonical_paths, ignoreGlobs);

  // Only rename file→file pairs. Skip canonicals that are directories (no extension, no dot in basename).
  // Deduplicate: a lookalike source can only be consumed once (first canonical wins).
  const usedSources = new Set<string>();
  const renames: { from: string; to: string }[] = [];
  for (const f of findings) {
    if (f.present || f.lookalike === null) continue;
    // Skip directory-style canonicals (no file extension and no dot after last slash)
    const canonicalBase = f.canonical.split("/").pop() ?? f.canonical;
    if (!canonicalBase.includes(".")) continue;
    if (usedSources.has(f.lookalike)) continue;
    usedSources.add(f.lookalike);
    renames.push({ from: f.lookalike, to: f.canonical });
  }

  if (renames.length === 0) {
    info("nothing to migrate");
    return;
  }

  // Print plan
  process.stdout.write("Rename plan:\n");
  for (const r of renames) {
    process.stdout.write(`  ${r.from} → ${r.to}\n`);
  }
  process.stdout.write("\n");

  if (!opts.yes && !(await confirm("Apply renames with git mv?"))) {
    info("aborted");
    return;
  }

  // Execute renames
  for (const r of renames) {
    const destAbs = join(cwd, r.to);
    await mkdir(dirname(destAbs), { recursive: true });
    await execFile("git", ["mv", r.from, r.to], { cwd });
  }

  // Commit the renames
  await execFile("git", ["commit", "-m", `migrate-layout: rename lookalikes to canonical paths (pack=${opts.pack})`], { cwd });

  info(`migrated ${renames.length} file(s) — re-run adopt to proceed`);
}
