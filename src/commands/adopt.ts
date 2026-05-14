import { readFile, writeFile, mkdir, stat, rename } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { info, err, confirm } from "../lib/log.js";
import pkg from "../../package.json" with { type: "json" };

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

export async function adoptCmd(opts: { pack: string; yes?: boolean; backupSettings?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  if (await exists(join(cwd, ".claude-ds.json"))) { err(".claude-ds.json already exists"); process.exit(2); }
  const settingsPath = join(cwd, ".claude/settings.json");
  if (await exists(settingsPath) && !opts.backupSettings) {
    err(".claude/settings.json present; pass --backup-settings to back it up before adopting");
    process.exit(2);
  }
  if (!opts.yes && !(await confirm(`Adopt claude-ds (pack=${opts.pack}, WARN mode) here?`))) { info("aborted"); return; }
  if (opts.backupSettings && await exists(settingsPath)) {
    await rename(settingsPath, `${settingsPath}.pre-claude-ds`);
  }

  const packDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../packs", opts.pack);
  const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
  for (const f of manifest.files) {
    if (f.category === "generated") continue;
    const srcName = f.path === "package.json" ? "package.json.seed" : f.path === "CLAUDE.md" ? "CLAUDE.md.fragment" : f.path;
    const dest = join(cwd, f.path);
    if (f.category === "seeded" && await exists(dest)) continue;
    const content = await readFile(join(packDir, "files", srcName), "utf8");
    await mkdir(dirname(dest), { recursive: true });
    if (f.category === "hybrid" && f.format === "markdown" && await exists(dest)) {
      const cur = await readFile(dest, "utf8");
      const merged = `${cur}\n<!-- >>> claude-ds managed >>> -->\n${content}\n<!-- <<< claude-ds managed <<< -->\n`;
      await writeFile(dest, merged, "utf8");
    } else if (f.category === "hybrid" && f.format === "markdown") {
      await writeFile(dest, `# Project\n<!-- >>> claude-ds managed >>> -->\n${content}\n<!-- <<< claude-ds managed <<< -->\n`, "utf8");
    } else {
      await writeFile(dest, content, "utf8");
    }
  }
  const cfg = { version: `v${pkg.version}`, pack: opts.pack, mode: "warn", enforce_threshold: 10, removed: [] };
  await writeFile(join(cwd, ".claude-ds.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
  info(`adopted claude-ds (${opts.pack}, mode=warn). Run 'enforce' when ready.`);
}
