import { readFile, stat, writeFile, mkdir, rm, readdir, copyFile, chmod } from "node:fs/promises";
import { join, dirname, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseManifest, type ManagedRoot } from "../lib/manifest.js";
import { parseConfig } from "../lib/config.js";
import { resolveManifestPath, detectAppDir } from "../lib/paths.js";
import { loadProject } from "../lib/project.js";
import { parseExceptions, openCount, lintExceptions, type ExceptionLint, type IssueChecker } from "../lib/exceptions.js";
import { detectLookalikes, Finding } from "../lib/lookalike.js";
import { detectPackageManager, PackageManager } from "../lib/package-manager.js";
import { scanRootDupes, RootDupeFinding } from "../lib/root-dupes.js";

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function walkDir(base: string, rel: string): Promise<string[]> {
  const abs = join(base, rel);
  let entries;
  try { entries = await readdir(abs, { withFileTypes: true }); } catch { return []; }
  const results: string[] = [];
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) results.push(...await walkDir(base, childRel));
    else results.push(childRel);
  }
  return results;
}

const COMPLETENESS_FALLBACK_ROOTS: ManagedRoot[] = [
  { root: ".claude/skills/", strict: true },
  { root: ".claude/hooks/", strict: true },
  { root: "design-system/", strict: true },
];

const WORKAROUND_RE = /(?:\/\/|\/\*|\*)\s*(?:WORKAROUND|HACK|FIXME)\b/i;
const SHELL_WORKAROUND_RE = /^\s*#\s+(?:WORKAROUND|HACK|FIXME)\b/i;
const ISSUE_REF_RE = /#\d+|https?:\/\/github\.com\/\S+\/issues\/\d+/;
const SCANNABLE_EXTS = new Set([".ts", ".tsx", ".css", ".md", ".sh"]);

interface CompletenessWorkaround { file: string; line: number; text: string; }

function stripTrailingSlash(p: string): string {
  return p.endsWith("/") ? p.slice(0, -1) : p;
}

/** Returns the configured managed roots, or the fallback list if none are declared. */
function resolveRoots(managedRoots: ManagedRoot[]): ManagedRoot[] {
  return managedRoots.length > 0 ? managedRoots : COMPLETENESS_FALLBACK_ROOTS;
}

async function findOrphanFiles(
  cwd: string,
  manifestPaths: Set<string>,
  roots: ManagedRoot[],
): Promise<string[]> {
  const openPrefixes = roots
    .filter(r => !r.strict)
    .map(r => `${stripTrailingSlash(r.root)}/`);

  const orphans: string[] = [];
  for (const { root, strict } of roots) {
    if (!strict) continue;
    const files = await walkDir(cwd, stripTrailingSlash(root));
    for (const f of files) {
      if (openPrefixes.some(prefix => f.startsWith(prefix))) continue;
      if (!manifestPaths.has(f)) orphans.push(f);
    }
  }
  return orphans;
}

async function scanWorkaroundComments(cwd: string, roots: ManagedRoot[]): Promise<CompletenessWorkaround[]> {
  const seen = new Set<string>();
  const results: CompletenessWorkaround[] = [];

  for (const { root } of roots) {
    const files = await walkDir(cwd, stripTrailingSlash(root));
    for (const f of files) {
      if (seen.has(f)) continue;
      seen.add(f);
      if (!SCANNABLE_EXTS.has(extname(f))) continue;
      let content: string;
      try { content = await readFile(join(cwd, f), "utf8"); } catch { continue; }
      const re = f.endsWith(".sh") ? SHELL_WORKAROUND_RE : WORKAROUND_RE;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (re.test(line) && !ISSUE_REF_RE.test(line)) {
          results.push({ file: f, line: i + 1, text: line.trim() });
        }
      }
    }
  }
  return results;
}

function makeGhIssueChecker(): IssueChecker {
  return async (ref: string): Promise<"open" | "closed" | "unknown"> => {
    try {
      const arg = ref.startsWith("#") ? ref.slice(1) : ref;
      const stdout = await new Promise<string>((res, rej) => {
        execFile("gh", ["issue", "view", arg, "--json", "state"], {}, (err, out) => {
          if (err) rej(err); else res(out);
        });
      });
      const { state } = JSON.parse(stdout) as { state: string };
      if (state === "OPEN") return "open";
      if (state === "CLOSED") return "closed";
      return "unknown";
    } catch {
      return "unknown";
    }
  };
}

async function runCompletenessCheck(opts: { pack?: string; cwd?: string }): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  let pack = opts.pack;
  if (!pack) {
    const cfgPath = join(cwd, ".claude-ds.json");
    if (!(await exists(cfgPath))) {
      process.stderr.write("error: --pack required (no .claude-ds.json found)\n");
      process.exit(2);
    }
    const cfg = parseConfig(await readFile(cfgPath, "utf8"));
    pack = cfg.pack;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const packDir = join(repoRoot, "packs", pack);
  const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
  const manifestPaths = new Set(manifest.files.map(f => f.path));
  const roots = resolveRoots(manifest.managed_roots);

  const orphans = await findOrphanFiles(cwd, manifestPaths, roots);

  const exceptionsPath = join(cwd, "design-system/exceptions.json");
  let exceptionWarnings: ExceptionLint[] = [];
  if (await exists(exceptionsPath)) {
    try {
      const exceptions = parseExceptions(await readFile(exceptionsPath, "utf8"));
      exceptionWarnings = await lintExceptions(exceptions, makeGhIssueChecker());
    } catch {
      // malformed exceptions.json — audit catches parse errors, not completeness's concern
    }
  }

  const workarounds = await scanWorkaroundComments(cwd, roots);

  const lines: string[] = ["## claude-ds doctor --completeness\n"];

  if (orphans.length > 0) {
    lines.push(`### Orphan files (${orphans.length} found — under DS scope but not pack-managed)\n`);
    for (const o of orphans) lines.push(`- \`${o}\``);
    lines.push("");
  }

  if (exceptionWarnings.length > 0) {
    lines.push(`### Exception lint warnings (${exceptionWarnings.length} found)\n`);
    for (const w of exceptionWarnings) lines.push(`- ${w.warning}`);
    lines.push("");
  }

  if (workarounds.length > 0) {
    lines.push(`### Workaround comments without removal triggers (${workarounds.length} found)\n`);
    for (const w of workarounds) lines.push(`- \`${w.file}:${w.line}\`: ${w.text}`);
    lines.push("");
  }

  const totalFindings = orphans.length + exceptionWarnings.length + workarounds.length;
  if (totalFindings === 0) {
    lines.push("✓ Completeness OK — no local DS infrastructure outside pack-managed scaffold\n");
  } else {
    lines.push(`✗ Completeness check failed: ${totalFindings} finding(s)\n`);
  }

  process.stdout.write(lines.join("\n"));

  if (totalFindings > 0) process.exit(1);
}

interface DriftResult {
  missing: string[];
  open_exceptions: number;
}

interface DoctorResult {
  mode: "pre-adopt" | "post-adopt";
  canonical: Finding[];
  drift?: DriftResult;
  packageManager: PackageManager;
  rootDupes?: RootDupeFinding[];
}

function renderMarkdown(result: DoctorResult): string {
  const lines: string[] = [];

  if (result.mode === "pre-adopt") {
    lines.push("## claude-ds doctor — pre-adopt mode\n");
    lines.push(`Package manager: **${result.packageManager}**\n`);
    lines.push("No `.claude-ds.json` found. Run `adopt` to install the scaffold.\n");

    const lookalikes = result.canonical.filter(f => !f.present && f.lookalike !== null);
    const missing = result.canonical.filter(f => !f.present && f.lookalike === null);
    const present = result.canonical.filter(f => f.present);

    if (lookalikes.length > 0) {
      lines.push("### Rename required before `adopt`\n");
      lines.push("The following files/dirs look like canonical names but use different vocabulary.");
      lines.push("Rename them to canonical names before running `adopt`.\n");
      for (const f of lookalikes) {
        lines.push(`- [ ] \`${f.lookalike}\` → \`${f.canonical}\` (lookalike detected)`);
      }
      lines.push("");
    }

    if (missing.length > 0) {
      lines.push("### Not yet present (will be seeded by `adopt`)\n");
      for (const f of missing) {
        lines.push(`- [ ] \`${f.canonical}\` — not present`);
      }
      lines.push("");
    }

    if (present.length > 0) {
      lines.push("### Already present\n");
      for (const f of present) {
        lines.push(`- [x] \`${f.canonical}\``);
      }
      lines.push("");
    }
  } else {
    lines.push("## claude-ds doctor — post-adopt mode\n");
    lines.push(`Package manager: **${result.packageManager}**\n`);

    const lookalikes = result.canonical.filter(f => !f.present && f.lookalike !== null);
    const missing = result.canonical.filter(f => !f.present && f.lookalike === null);
    const present = result.canonical.filter(f => f.present);

    if (lookalikes.length > 0) {
      lines.push("### Managed files with lookalikes (rename or re-adopt)\n");
      for (const f of lookalikes) {
        lines.push(`- [ ] \`${f.canonical}\` missing — lookalike: \`${f.lookalike}\``);
      }
      lines.push("");
    }

    if (missing.length > 0) {
      lines.push("### Missing managed files\n");
      for (const f of missing) {
        lines.push(`- [ ] \`${f.canonical}\` — not present`);
      }
      lines.push("");
    }

    if (present.length > 0) {
      lines.push("### Managed files present\n");
      for (const f of present) {
        lines.push(`- [x] \`${f.canonical}\``);
      }
      lines.push("");
    }

    if (result.drift) {
      lines.push(`### Exceptions: ${result.drift.open_exceptions} open\n`);
    }
  }

  // Root-dupe section — applies to both modes when dupes are detected (#23)
  if (result.rootDupes && result.rootDupes.length > 0) {
    lines.push("### Root-level duplicates of canonical design-system/ files\n");
    lines.push("These files existed before `adopt` and were not removed. Run `reconcile` to resolve.\n");
    for (const d of result.rootDupes) {
      const note = d.contentDiffers ? "(content differs — merge required)" : "(content identical — safe to delete root)";
      lines.push(`- [ ] \`${d.rootPath}\` duplicates \`${d.canonicalPath}\` ${note}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Fixture shape for verify-fixture.json
interface VerifyFixtureSetup { path: string; content: string; }
interface VerifyFixture {
  pass: {
    arg: string;
    setup: VerifyFixtureSetup[];
    needs_similarity_script?: boolean;
  };
}

interface HookVerifyResult {
  hook: string;
  status: "PASS" | "FAIL";
  reason?: string;
}

const STDERR_CONTRACT = /^[^:]+:\d+: [A-Z]+-\d+: .+/m;

function runHookWithTimeout(
  hookPath: string,
  arg: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile("bash", [hookPath, arg], { cwd, timeout: timeoutMs }, (err, _stdout, stderr) => {
      // When hook exits non-zero, err is set. err.code holds numeric exit code for ChildProcessError.
      const code = err
        ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? (err as NodeJS.ErrnoException & { code: number }).code
            : 1)
        : 0;
      resolve({ code, stderr });
    });
  });
}

async function verifyHooks(packDir: string, cwd: string): Promise<HookVerifyResult[]> {
  const hooksDir = join(packDir, "files/.claude/hooks");
  const hookFiles = (await readdir(hooksDir)).filter(f => f.endsWith(".sh"));

  const results: HookVerifyResult[] = [];

  for (const hookFile of hookFiles.sort()) {
    const hookPath = join(cwd, ".claude/hooks", hookFile);
    const fixturePath = join(hooksDir, `${hookFile}.verify-fixture.json`);

    // Check hook exists on disk
    if (!(await exists(hookPath))) {
      results.push({ hook: hookFile, status: "FAIL", reason: "hook script missing from adopted project" });
      continue;
    }

    // Check fixture exists
    if (!(await exists(fixturePath))) {
      results.push({ hook: hookFile, status: "FAIL", reason: "no verify-fixture.json found" });
      continue;
    }

    let fixture: VerifyFixture;
    try {
      fixture = JSON.parse(await readFile(fixturePath, "utf8")) as VerifyFixture;
    } catch {
      results.push({ hook: hookFile, status: "FAIL", reason: "malformed verify-fixture.json" });
      continue;
    }

    const { pass } = fixture;

    // Build a temp working dir for this hook invocation
    const tmp = await mkdtemp(join(tmpdir(), "claude-ds-verify-"));
    try {
      // Copy hook scripts from the ADOPTED project (cwd) so we exercise what's actually on disk.
      // This ensures replaced/modified hooks are tested, not the pack originals.
      const adoptedHooksDir = join(cwd, ".claude/hooks");
      const tmpHooksDir = join(tmp, ".claude/hooks");
      const tmpHooksLib = join(tmp, ".claude/hooks/lib");
      await mkdir(tmpHooksLib, { recursive: true });

      // Copy all .sh files and lib/ from the adopted project
      for (const f of await readdir(adoptedHooksDir)) {
        const src = join(adoptedHooksDir, f);
        const dst = join(tmpHooksDir, f);
        const s = await stat(src);
        if (s.isDirectory()) {
          await mkdir(dst, { recursive: true });
          for (const lf of await readdir(src)) {
            await copyFile(join(src, lf), join(dst, lf));
            await chmod(join(dst, lf), 0o755);
          }
        } else if (f.endsWith(".sh")) {
          await copyFile(src, dst);
          await chmod(dst, 0o755);
        }
      }

      // Seed setup files
      for (const s of pass.setup) {
        const filePath = join(tmp, s.path);
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, s.content, "utf8");
      }

      // For similarity hook, copy similarity-check.ts
      if (pass.needs_similarity_script) {
        const simSrc = join(packDir, "files/scripts/similarity-check.ts");
        const simDst = join(tmp, "scripts/similarity-check.ts");
        await mkdir(dirname(simDst), { recursive: true });
        await copyFile(simSrc, simDst);
      }

      const hookInTmp = join(tmp, ".claude/hooks", hookFile);
      const { code, stderr } = await runHookWithTimeout(hookInTmp, pass.arg, tmp, 5000);

      if (code === 0) {
        results.push({ hook: hookFile, status: "PASS" });
      } else if (code === 2) {
        // exit 2 from pass payload — unexpected block; check if stderr matches contract
        if (STDERR_CONTRACT.test(stderr)) {
          results.push({ hook: hookFile, status: "FAIL", reason: "hook blocked pass payload (exit 2)" });
        } else {
          results.push({ hook: hookFile, status: "FAIL", reason: "stderr does not match contract" });
        }
      } else if (code === 1) {
        // exit 1 is self-error
        results.push({ hook: hookFile, status: "FAIL", reason: `hook self-error (exit 1): ${stderr.slice(0, 120).trim()}` });
      } else {
        results.push({ hook: hookFile, status: "FAIL", reason: `unexpected exit code ${code}` });
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  return results;
}

function renderVerifyTable(results: HookVerifyResult[]): string {
  const lines: string[] = [];
  lines.push("## claude-ds doctor --verify-hooks\n");
  lines.push("| Hook | Result | Reason |");
  lines.push("|------|--------|--------|");
  for (const r of results) {
    const reason = r.reason ?? "";
    lines.push(`| ${r.hook} | ${r.status} | ${reason} |`);
  }
  lines.push("");
  const passed = results.filter(r => r.status === "PASS").length;
  const total = results.length;
  lines.push(`${passed}/${total} hooks verified.\n`);
  return lines.join("\n");
}

export async function doctorCmd(opts: { pack?: string; ignore?: string; cwd?: string; verifyHooks?: boolean; completeness?: boolean }): Promise<void> {
  if (opts.completeness) {
    await runCompletenessCheck({ pack: opts.pack, cwd: opts.cwd });
    return;
  }
  const cwd = opts.cwd ?? process.cwd();
  let pack = opts.pack;
  if (!pack) {
    const cfgPath = join(cwd, ".claude-ds.json");
    if (!(await exists(cfgPath))) {
      process.stderr.write("error: --pack required (no .claude-ds.json found)\n");
      process.exit(2);
    }
    const cfg = parseConfig(await readFile(cfgPath, "utf8"));
    pack = cfg.pack;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const packDir = join(repoRoot, "packs", pack);

  if (opts.verifyHooks) {
    const results = await verifyHooks(packDir, cwd);
    const table = renderVerifyTable(results);
    process.stdout.write(table);
    const anyFail = results.some(r => r.status === "FAIL");
    if (anyFail) process.exit(1);
    return;
  }

  const manifestRaw = await readFile(join(packDir, "manifest.json"), "utf8");
  const manifest = parseManifest(manifestRaw);

  // Load ignore globs from on-disk config (if present), then merge with --ignore flag globs.
  // Order: pack defaults < project config < --ignore flag (project/flag extend, not replace).
  const configPath = join(cwd, ".claude-ds.json");
  let configIgnore: string[] = [];
  let appDir: string = "app";
  if (await exists(configPath)) {
    try {
      const cfg = parseConfig(await readFile(configPath, "utf8"));
      configIgnore = cfg.lookalike_ignore;
      appDir = cfg.app_dir;
    } catch {
      // parseConfig will error properly later; don't block doctor on it here
    }
  } else {
    // Pre-adopt: detect src/ layout so doctor doesn't false-positive on src/app projects (#58)
    appDir = await detectAppDir(cwd);
  }

  // Resolve canonical paths through app_dir for the fs existence check (#58).
  // app/* → <app_dir>/* so src/app projects don't false-positive.
  // We pass resolved paths to detectLookalikes, then remap Finding.canonical back
  // to the original manifest path for display (output stays grep-friendly with app/).
  const resolvedToManifest = new Map<string, string>();
  const resolvedCanonicalPaths = manifest.canonical_paths.map(p => {
    const resolved = resolveManifestPath(p, appDir);
    resolvedToManifest.set(resolved, p);
    return resolved;
  });

  const flagGlobs = opts.ignore ? opts.ignore.split(",").map(g => g.trim()).filter(Boolean) : [];
  const ignoreGlobs = [...manifest.lookalike_ignore, ...configIgnore, ...flagGlobs];

  const rawFindings = await detectLookalikes(cwd, resolvedCanonicalPaths, ignoreGlobs);
  // Remap resolved paths back to manifest-canonical display paths.
  const findings = rawFindings.map(f => ({
    ...f,
    canonical: resolvedToManifest.get(f.canonical) ?? f.canonical,
  }));
  const pm = await detectPackageManager(cwd);

  // #23: scan for root-level dupes of canonical design-system/ files
  const rootDupes = await scanRootDupes(cwd, manifest.deprecated_paths);

  const isPostAdopt = await exists(configPath);

  let result: DoctorResult;

  if (isPostAdopt) {
    // Post-adopt: check drift (missing managed files + exception count)
    // loadProject handles the #47/#34 backfill + persist of app_dir / claude_md_target.
    const ctx = await loadProject(cwd);
    const cfg = ctx.cfg;
    let openExceptions = 0;
    const exceptionsPath = join(cwd, "design-system/exceptions.json");
    if (await exists(exceptionsPath)) {
      try {
        const ex = parseExceptions(await readFile(exceptionsPath, "utf8"));
        openExceptions = openCount(ex);
      } catch {
        // Seeded exceptions.json may be empty/stub — treat as 0 exceptions
        openExceptions = 0;
      }
    }

    // Check which managed files are missing.
    // Resolve through app_dir so src/app projects (#58) don't false-positive.
    // Store the manifest path for display; check the resolved path on disk.
    const managedFiles = manifest.files.filter(f => f.category === "managed");
    const missingManaged: string[] = [];
    for (const f of managedFiles) {
      const resolvedPath = resolveManifestPath(f.path, appDir);
      if (!(await exists(join(cwd, resolvedPath)))) missingManaged.push(f.path);
    }

    result = {
      mode: "post-adopt",
      canonical: findings,
      drift: {
        missing: missingManaged,
        open_exceptions: openExceptions,
      },
      packageManager: pm,
      rootDupes: rootDupes.length > 0 ? rootDupes : undefined,
    };

    // Suppress unused variable warning
    void cfg;
  } else {
    result = {
      mode: "pre-adopt",
      canonical: findings,
      packageManager: pm,
      rootDupes: rootDupes.length > 0 ? rootDupes : undefined,
    };
  }

  const md = renderMarkdown(result);
  const json = JSON.stringify(result, null, 2);
  const output = `${md}\n\`\`\`json\n${json}\n\`\`\`\n`;

  process.stdout.write(output);

  // Exit 1 if any findings: lookalikes present, managed files missing, or root dupes detected (#23)
  const hasLookalikes = findings.some(f => !f.present && f.lookalike !== null);
  const hasMissingManaged = result.drift && result.drift.missing.length > 0;
  const hasRootDupes = rootDupes.length > 0;

  if (hasLookalikes || hasMissingManaged || hasRootDupes) {
    if (hasLookalikes) {
      process.stderr.write("If these matches are false positives, re-run with --ignore '<glob>,<glob>'\n");
    }
    if (hasRootDupes) {
      process.stderr.write("Root-level duplicates detected — run `reconcile` to resolve\n");
    }
    process.exit(1);
  }
}
