import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { classify } from "../lib/classify.js";
import { parseConfig } from "../lib/config.js";
import { info, err, confirm } from "../lib/log.js";

async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch { return false; } }

export async function migrateCmd(opts: { source: string; tier?: "atom"|"composite"; rename?: string; reason: string; yes?: boolean; cwd?: string }) {
  const cwd = opts.cwd ?? process.cwd();
  parseConfig(await readFile(join(cwd, ".claude-ds.json"), "utf8"));
  const abs = resolve(cwd, opts.source);
  if (!abs.startsWith(resolve(cwd) + "/")) { err("source outside project root"); process.exit(2); }
  const s = await stat(abs);
  if (s.isDirectory()) { err("source is a directory"); process.exit(2); }
  if (!abs.endsWith(".tsx")) { err("only .tsx components are supported at v1"); process.exit(2); }
  const src = await readFile(abs, "utf8");
  let tier: "atom"|"composite";
  try { tier = opts.tier ?? classify(src); } catch (e) { err((e as Error).message); process.exit(2); return; }
  const destName = opts.rename ?? basename(abs);
  const dest = join(cwd, "design-system", tier === "atom" ? "atoms" : "composites", destName);
  if (await exists(dest)) { err(`destination exists: ${dest} (pass --rename to override)`); process.exit(2); }
  if (!opts.yes && !(await confirm(`Migrate ${opts.source} → ${dest}?`))) { info("aborted"); return; }
  await mkdir(dirname(dest), { recursive: true });
  await rename(abs, dest);
  const showcase = dest.replace(/\.tsx$/, ".showcase.tsx");
  const states = dest.replace(/\.tsx$/, ".states.json");
  await writeFile(showcase, `// auto-generated showcase stub for ${destName}\nexport default function Showcase(){ return null; }\n`, "utf8");
  await writeFile(states, `[]`, "utf8");
  const exPath = join(cwd, "exceptions.json");
  const cur = JSON.parse(await readFile(exPath, "utf8"));
  const expiry = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  cur.push({ rule_id: "migration-default", file: dest.replace(cwd + "/", ""), reason: opts.reason, expiry });
  await writeFile(exPath, JSON.stringify(cur, null, 2) + "\n", "utf8");
  info(`migrated → ${dest} (tier=${tier}), exception registered (expiry=${expiry})`);
}
