import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { mergeJsonKeys } from "../lib/json-merge.js";
import { info, err, confirm } from "../lib/log.js";
import { detectLookalikes } from "../lib/lookalike.js";

// Read package.json for version (avoid JSON import assertions for broader compat).
async function getVersion(packageJsonPath: string): Promise<string> {
  const raw = await readFile(packageJsonPath, "utf8");
  return JSON.parse(raw).version as string;
}

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

interface OverwriteRecord { path: string; prevSize: number; newSize: number; }

export async function adoptCmd(opts: { pack: string; yes?: boolean; ignore?: string; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  if (await exists(join(cwd, ".claude-ds.json"))) { err(".claude-ds.json already exists"); process.exit(2); }

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const packDir = join(repoRoot, "packs", opts.pack);
  const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));

  // Parse --ignore flag globs (comma-separated).
  // Merge order: pack defaults < --ignore flag (flag extends, not replaces).
  const flagGlobs = opts.ignore ? opts.ignore.split(",").map(g => g.trim()).filter(Boolean) : [];
  const ignoreGlobs = [...manifest.lookalike_ignore, ...flagGlobs];

  // Precondition gate runs BEFORE the confirmation prompt — fail fast on lookalikes.
  // ignoreGlobs lets users suppress false positives from the heuristic.
  const findings = await detectLookalikes(cwd, manifest.canonical_paths, ignoreGlobs);
  const blockers = findings.filter(f => !f.present && f.lookalike !== null);
  if (blockers.length > 0) {
    const lines: string[] = [
      "adopt refused: lookalike files detected — rename to canonical names first.",
      "",
      "The following project files use different vocabulary than the canonical names.",
      "Rename them before running adopt (use `doctor` to see the full report):",
      "",
    ];
    for (const b of blockers) {
      lines.push(`  ${b.lookalike} → ${b.canonical}`);
    }
    lines.push("");
    lines.push("No files were modified.");
    lines.push("If these matches are false positives, re-run with --ignore '<glob>,<glob>'");
    process.stderr.write(lines.join("\n") + "\n");
    process.exit(2);
  }

  if (!opts.yes && !(await confirm(`Adopt claude-ds (pack=${opts.pack}, WARN mode) here?`))) { info("aborted"); return; }

  const overwrites: OverwriteRecord[] = [];

  for (const f of manifest.files) {
    if (f.category === "generated") continue;
    const srcName = f.path === "package.json" ? "package.json.seed" : f.path === "CLAUDE.md" ? "CLAUDE.md.fragment" : f.path;
    const dest = resolve(cwd, f.path);
    const cwdResolved = resolve(cwd);
    if (dest !== cwdResolved && !dest.startsWith(cwdResolved + "/")) {
      err(`manifest path escapes project root: ${f.path}`);
      process.exit(2);
    }
    if (f.category === "seeded" && await exists(dest)) continue;
    const content = await readFile(join(packDir, "files", srcName), "utf8");
    await mkdir(dirname(dest), { recursive: true });
    if (f.category === "hybrid" && f.format === "markdown" && await exists(dest)) {
      const cur = await readFile(dest, "utf8");
      const merged = `${cur}\n<!-- >>> claude-ds managed >>> -->\n${content}\n<!-- <<< claude-ds managed <<< -->\n`;
      // Record overwrite only when merged result differs from current on-disk content.
      if (merged !== cur) {
        overwrites.push({ path: f.path, prevSize: Buffer.byteLength(cur, "utf8"), newSize: Buffer.byteLength(merged, "utf8") });
      }
      await writeFile(dest, merged, "utf8");
    } else if (f.category === "hybrid" && f.format === "markdown") {
      await writeFile(dest, `# Project\n<!-- >>> claude-ds managed >>> -->\n${content}\n<!-- <<< claude-ds managed <<< -->\n`, "utf8");
    } else if (f.category === "hybrid" && f.format === "json") {
      if (await exists(dest)) {
        const current = await readFile(dest, "utf8");
        // Detect existing indentation: find first indented line, check if it starts with a tab.
        const firstIndented = current.split("\n").find(l => l.startsWith(" ") || l.startsWith("\t"));
        const indent = firstIndented && firstIndented.startsWith("\t") ? "\t" : 2;
        const merged = mergeJsonKeys(content, current, f.owned_keys ?? ["hooks"], indent);
        if (merged !== current) {
          overwrites.push({ path: f.path, prevSize: Buffer.byteLength(current, "utf8"), newSize: Buffer.byteLength(merged, "utf8") });
        }
        await writeFile(dest, merged, "utf8");
      } else {
        await writeFile(dest, content, "utf8");
      }
    } else {
      // managed category: check for overwrite before writing.
      if (f.category === "managed" && await exists(dest)) {
        const current = await readFile(dest, "utf8");
        if (current !== content) {
          overwrites.push({ path: f.path, prevSize: Buffer.byteLength(current, "utf8"), newSize: Buffer.byteLength(content, "utf8") });
        }
      }
      await writeFile(dest, content, "utf8");
    }
  }

  // Print overwrite summary BEFORE success line so it's not buried.
  if (overwrites.length > 0) {
    const lines: string[] = [`Overwrote ${overwrites.length} managed file(s):`];
    for (const o of overwrites) {
      lines.push(`  ${o.path}  (was ${o.prevSize} bytes, now ${o.newSize} bytes)`);
    }
    lines.push("Project-specific customizations to these files have been replaced.");
    lines.push("To diff before adopt, run: claude-ds doctor --pack <name>");
    process.stdout.write(lines.join("\n") + "\n");
  }

  const version = await getVersion(join(repoRoot, "package.json"));
  const cfg: Record<string, unknown> = { version: `v${version}`, pack: opts.pack, mode: "warn", enforce_threshold: 10, removed: [] };
  if (flagGlobs.length > 0) cfg.lookalike_ignore = flagGlobs;
  await writeFile(join(cwd, ".claude-ds.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
  info(`adopted claude-ds (${opts.pack}, mode=warn). Run 'enforce' when ready.`);
}
