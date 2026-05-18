import { readFile, writeFile, stat, mkdir, chmod } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../lib/config.js";
import { parseManifest } from "../lib/manifest.js";
import { diffFile } from "../lib/sync-diff.js";
import { parseLsRemote } from "../lib/tags.js";
import { info, err, confirm } from "../lib/log.js";
import { resolveManifestPath } from "../lib/paths.js";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

export async function syncCmd(opts: { offlineFixture?: string; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  if (!(await exists(join(cwd, ".claude-ds.json")))) { err(".claude-ds.json absent"); process.exit(2); }
  const cfg = parseConfig(await readFile(join(cwd, ".claude-ds.json"), "utf8"));

  // Resolve repo root from this file's location (src/commands or dist/commands → up two levels)
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");

  let packDir: string;
  let target: string;
  if (opts.offlineFixture) {
    // Relative fixture paths are resolved from repo root (same as how pack names work in init)
    packDir = resolve(repoRoot, opts.offlineFixture);
    target = cfg.version;
  } else {
    const r = spawnSync("git", ["ls-remote", "--tags", "https://github.com/collod873/claude-ds"], { encoding: "utf8" });
    if (r.status !== 0) { err("network: cannot reach upstream"); process.exit(2); }
    const tags = parseLsRemote(r.stdout);
    target = tags[tags.length - 1] ?? cfg.version;
    packDir = join(repoRoot, "packs", cfg.pack);
  }

  const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
  const actions: Array<{ path: string; writePath: string; upstream: string; verdict: ReturnType<typeof diffFile> }> = [];
  for (const f of manifest.files) {
    if (f.category === "generated") continue;
    if (cfg.removed.includes(f.path)) continue;

    // #47: rewrite app/... → <app_dir>/... at I/O boundary.
    // #34: route CLAUDE.md to the configured target (default "CLAUDE.md" for back-compat).
    const writePath = f.path === "CLAUDE.md"
      ? cfg.claude_md_target
      : resolveManifestPath(f.path, cfg.app_dir);

    // Path-traversal guard: reject any manifest entry that escapes cwd
    const dest = join(cwd, writePath);
    const rel = relative(cwd, dest);
    if (rel.startsWith("..") || rel === "") { err(`path traversal rejected: ${f.path}`); process.exit(2); }

    const srcName = f.path === "package.json" ? "package.json.seed" : f.path === "CLAUDE.md" ? "CLAUDE.md.fragment" : f.path;
    let upstream = await readFile(join(packDir, "files", srcName), "utf8");
    // Fragment files ship without marker wrappers — add them so diffFile can extract the inner region.
    if (f.category === "hybrid" && f.format === "markdown" && srcName.endsWith(".fragment")) {
      upstream = `<!-- >>> claude-ds managed >>> -->\n${upstream}\n<!-- <<< claude-ds managed <<< -->`;
    } else if (f.category === "hybrid" && f.format === "shell" && srcName.endsWith(".fragment")) {
      upstream = `# >>> claude-ds managed >>>\n${upstream}\n# <<< claude-ds managed <<<`;
    }
    // v1 gap: no prior-snapshot cache — use prev=null so managed files without a known
    // prior state are treated as "upstream wins" rather than false-abort on hand-edit detection.
    const prev: string | null = null;
    const current = (await exists(dest)) ? await readFile(dest, "utf8") : null;
    const verdict = diffFile({ category: f.category, format: f.format, owned_keys: f.owned_keys }, { prev, upstream, current });
    actions.push({ path: f.path, writePath, upstream, verdict });
    // #18c: distinguish new files (create:) from content-changed files (rewrite:)
    const displayAction = (verdict.action === "rewrite" && current === null) ? "create" : verdict.action;
    // Log canonical path when it equals the write path; otherwise show both so consumers
    // see where pack content actually landed (e.g. "app/design/... → src/app/design/...").
    const displayPath = (writePath === f.path) ? f.path : `${f.path} → ${writePath}`;
    info(`${displayAction}: ${displayPath} — ${verdict.reason}`);
  }
  // #18d: summarise whether .claude-ds.json config keys (aside from version) will change
  {
    const nonVersionKeys = Object.keys(cfg).filter(k => k !== "version") as Array<keyof typeof cfg>;
    const nextVersion = target;
    const changedKeys = nonVersionKeys.filter(k => JSON.stringify(cfg[k]) !== JSON.stringify({ ...cfg, version: nextVersion }[k]));
    if (changedKeys.length > 0) {
      info(`config will change: ${changedKeys.join(", ")}`);
    } else {
      info("config unchanged");
    }
  }
  if (!(await confirm("Apply the above?"))) { info("aborted"); return; }
  for (const a of actions) {
    const dest = join(cwd, a.writePath);
    if (a.verdict.action === "rewrite") {
      await mkdir(dirname(dest), { recursive: true });
      const content = a.verdict.newContent ?? a.upstream;
      await writeFile(dest, content, "utf8");
      // #15: hook and script files must be executable
      if (a.writePath.startsWith(".claude/hooks/") || a.writePath.startsWith("scripts/")) await chmod(dest, 0o755);
    } else if (a.verdict.action === "rewrite-region") {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, a.verdict.newContent, "utf8");
      if (a.writePath.startsWith(".claude/hooks/") || a.writePath.startsWith("scripts/")) await chmod(dest, 0o755);
    } else if (a.verdict.action === "abort") {
      err(`skipped (abort): ${a.path} — ${a.verdict.reason}`);
    }
  }
  cfg.version = target;
  await writeFile(join(cwd, ".claude-ds.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
  info(`sync complete → ${target}`);
}
