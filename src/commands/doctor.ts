import { readFile, stat, writeFile, mkdir, rm, readdir, copyFile, chmod } from "node:fs/promises";
import { join, dirname, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseManifest, isManifestOrKeepfile, type ManagedRoot } from "../lib/manifest.js";
import { parseConfig } from "../lib/config.js";
import { resolveManifestPath } from "../lib/paths.js";
import { loadPreAdoptProject, loadProject, type ProjectContext } from "../lib/project.js";
import { parseExceptions, openCount, lintExceptions, type Exception, type ExceptionLint, type IssueChecker } from "../lib/exceptions.js";
import { detectLookalikes, Finding } from "../lib/lookalike.js";
import { detectPackageManager, PackageManager } from "../lib/package-manager.js";
import { scanRootDupes, RootDupeFinding } from "../lib/root-dupes.js";
import {
  scanOwnedConcerns,
  allOwnedConcernIds,
  formatOwnedConcernFinding,
  type OwnedConcernScannerFinding,
} from "../lib/owned-concerns/index.js";
import { checkVersionCurrency } from "../lib/version-currency.js";
import {
  computeVerificationChain,
  runMigrations,
} from "../lib/migration-framework.js";
import { MIGRATION_REGISTRY } from "../lib/migration-registry.js";
import { printNextStep, detectBuildCommand } from "../lib/log.js";
import pkg from "../../package.json" with { type: "json" };

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
  generatedPatterns: string[],
): Promise<string[]> {
  const openPrefixes = roots
    .filter(r => !r.strict)
    .map(r => `${stripTrailingSlash(r.root)}/`);

  let isGenerated: ((path: string) => boolean) | null = null;
  if (generatedPatterns.length > 0) {
    const { default: picomatch } = await import("picomatch");
    isGenerated = picomatch(generatedPatterns, { dot: true });
  }

  // Derive the set of skill subdirectory names the pack actually ships.
  // A file under .claude/skills/<name>/ is only DS-owned if <name> is one of these.
  const packSkillDirs = new Set(
    [...manifestPaths]
      .filter(p => p.startsWith(".claude/skills/"))
      .map(p => p.split("/")[2])
      .filter(Boolean),
  );

  const orphans: string[] = [];
  for (const { root, strict } of roots) {
    if (!strict) continue;
    const files = await walkDir(cwd, stripTrailingSlash(root));
    for (const f of files) {
      if (openPrefixes.some(prefix => f.startsWith(prefix))) continue;
      if (isManifestOrKeepfile(f, manifestPaths)) continue;
      if (isGenerated && isGenerated(f)) continue;
      // .claude/skills/ is a shared namespace: only treat files under pack-shipped
      // skill subdirectories as DS-owned. Consumer skill dirs are not orphans (#257).
      if (f.startsWith(".claude/skills/")) {
        const skillDir = f.split("/")[2];
        if (!packSkillDirs.has(skillDir)) continue;
      }
      orphans.push(f);
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

  const orphans = await findOrphanFiles(cwd, manifestPaths, roots, manifest.generated_patterns);

  const exceptionsPath = join(cwd, "design-system/exceptions.json");
  let exceptionWarnings: ExceptionLint[] = [];
  let permanentExceptions: Exception[] = [];
  let exceptions: Exception[] = [];
  if (await exists(exceptionsPath)) {
    try {
      exceptions = parseExceptions(await readFile(exceptionsPath, "utf8"));
      exceptionWarnings = await lintExceptions(exceptions, makeGhIssueChecker());
      permanentExceptions = exceptions.filter(e => e.permanent);
    } catch {
      // malformed exceptions.json — audit catches parse errors, not completeness's concern
    }
  }

  const workarounds = await scanWorkaroundComments(cwd, roots);

  // Owned-concern scan (ADR-0017): repo-wide, signature-as-identity. Catches
  // DS infrastructure hand-rolled in unowned dirs (scripts/, src/) that the
  // location-scoped orphan check above is blind to.
  const rawOwnedFindings: OwnedConcernScannerFinding[] = await scanOwnedConcerns({
    cwd,
    manifestPaths,
    generatedPatterns: manifest.generated_patterns,
  });
  // Suppress Owned-concern findings whose (rule, path) matches an exception
  // — same shape audit uses for drift/integrity (#316/#320). `permanent: true`
  // covers detector over-match; an issue-linked entry covers a tracked gap
  // pending upstream removal (ADR-0003).
  const suppressedSet = new Set(exceptions.map(e => `${e.rule}:${e.path}`));
  const ownedFindings = rawOwnedFindings.filter(
    f => !suppressedSet.has(`${f.concernId}:${f.file}`),
  );
  const ownedConcernsChecked = allOwnedConcernIds();

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

  if (ownedFindings.length > 0) {
    lines.push(`### Shadow DS infrastructure (${ownedFindings.length} found — Owned concerns)\n`);
    for (const f of ownedFindings) {
      lines.push(formatOwnedConcernFinding(f));
    }
    lines.push("");
  }

  if (permanentExceptions.length > 0) {
    lines.push(`### Permanent exceptions (${permanentExceptions.length} — informational)\n`);
    for (const e of permanentExceptions) lines.push(`- \`${e.path}\` (${e.rule}): ${e.reason ?? "no reason given"}`);
    lines.push("");
  }

  const totalFindings = orphans.length + exceptionWarnings.length + workarounds.length + ownedFindings.length;
  if (totalFindings === 0) {
    lines.push("✓ Completeness OK — no local DS infrastructure outside pack-managed scaffold\n");
  } else {
    lines.push(`✗ Completeness check failed: ${totalFindings} finding(s)\n`);
  }

  // Coverage footer (ADR-0017): print which Owned concerns were checked so the
  // verdict is honest about scope. A clean `✓` then tells the truth about what
  // was evaluated — the residual blind spot is precisely "a concern not yet in
  // the registry."
  lines.push(`Owned concerns checked: ${ownedConcernsChecked.join(", ")}\n`);

  process.stdout.write(lines.join("\n"));

  // #349 F21: every command — including doctor's completeness mode —
  // ends with a → Next breadcrumb. Findings route to the per-finding
  // remediation prose; a clean completeness check routes back to the
  // day-to-day build hint.
  const buildCmd = await detectBuildCommand(cwd);
  printNextStep("doctor", {
    doctorVerdict: totalFindings > 0 ? "completeness-findings" : "clean",
    buildCmd,
  });

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
    const child = execFile("bash", [hookPath, arg], { cwd, timeout: timeoutMs }, (err, _stdout, stderr) => {
      // When hook exits non-zero, err is set. err.code holds numeric exit code for ChildProcessError.
      const code = err
        ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? (err as NodeJS.ErrnoException & { code: number }).code
            : 1)
        : 0;
      resolve({ code, stderr });
    });
    child.stdin?.end();
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

export async function doctorCmd(opts: { pack?: string; ignore?: string; cwd?: string; verifyHooks?: boolean; completeness?: boolean; json?: boolean }): Promise<void> {
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
    // #349 F21: every command ends with a → Next breadcrumb. A failed hook
    // means the scaffold is broken — sync re-installs the pack files; a
    // clean hook-verify routes back to the day-to-day build hint.
    const buildCmd = await detectBuildCommand(cwd);
    printNextStep("doctor", {
      doctorVerdict: anyFail ? "scaffold-gap" : "clean",
      buildCmd,
    });
    if (anyFail) process.exit(1);
    return;
  }

  const manifestRaw = await readFile(join(packDir, "manifest.json"), "utf8");
  const manifest = parseManifest(manifestRaw);

  // Resolve appDir + lookalike-ignore via `ProjectContext` so doctor reads the
  // same `ctx.auditConfig.appDir` the audit command does — healing the prior
  // "audit detects src/app fall-through, doctor uses cfg.app_dir only" divergence
  // (PRD #266 Problem #2). The pre-adopt branch mints a real frozen ctx via
  // `loadPreAdoptProject` so the resolver — not a direct `detectAppDir` call —
  // owns the src/app detection that #58 introduced.
  const configPath = join(cwd, ".claude-ds.json");
  const isPostAdopt = await exists(configPath);
  let ctx: ProjectContext;
  if (isPostAdopt) {
    try {
      // loadProject handles the #47/#34 backfill + persist of app_dir / claude_md_target.
      ctx = await loadProject(cwd);
    } catch {
      // Malformed config — fall back to pre-adopt resolution so doctor still runs.
      ctx = await loadPreAdoptProject(cwd, { pack, packDir, manifest });
    }
  } else {
    ctx = await loadPreAdoptProject(cwd, { pack, packDir, manifest });
  }
  const { appDir } = ctx.auditConfig;
  // `lookalike_ignore` is not in the audit-config bundle (it is doctor-specific,
  // not shared with detect/classify/fix). Only the adopted ctx has a full cfg.
  const configIgnore: string[] = ctx.kind === "adopted" ? ctx.cfg.lookalike_ignore : [];

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

  let result: DoctorResult;

  if (ctx.kind === "adopted") {
    // Post-adopt: check drift (missing managed files + exception count)
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

  // #349 F16: aggregate scaffold-gap + open-exceptions + repair-needed +
  // upgrade-available into the health verdict so a clean all-clear isn't
  // blind to what upgrade/repair would act on. Both signals require an
  // adopted project (a parsed config carries `packVersion`); pre-adopt
  // doctor leaves them at zero.
  let upgradeAvailable = false;
  let repairNeeded = 0;
  if (ctx.kind === "adopted") {
    upgradeAvailable = checkVersionCurrency({
      pinned: ctx.cfg.packVersion,
      installed: `v${pkg.version}`,
    }).upgradeAvailable;

    // Repair-needed = N regressed migration end-states at the current
    // packVersion. Same dry-run check `upgrade` already uses — every
    // migration's `plan()` is idempotent and re-emits its Changes when the
    // end-state drifted (the meta_kind_strict regression #300 closed). A
    // failure here is a doctor concern, not a hard exit, so swallow plan
    // errors and report "0 repaired" rather than crashing the verdict.
    try {
      const verifyChain = computeVerificationChain(ctx.cfg.packVersion, MIGRATION_REGISTRY);
      if (verifyChain.length > 0) {
        const dryReport = await runMigrations(ctx, verifyChain, "dry-run");
        repairNeeded = dryReport.ops.filter((o) => o.changes.length > 0).length;
      }
    } catch {
      // Best-effort: keep doctor running even if the verification chain
      // hits a plan error. The next `upgrade` invocation will surface the
      // failure with its own error path.
    }
  }

  // PRD #340 sub-issue #344: doctor no longer emits both unconditionally.
  // `--json` selects the machine surface; default is the human checklist.
  // Pre-#344 every invocation dumped both. The verdict aggregation above
  // still runs in both modes — it feeds the exit code, not just the render.
  //
  // Issue #408: under `--json` we defer the emit until the verdict is
  // computed below so the headless contract envelope can wrap the existing
  // DoctorResult shape. Non-JSON mode still emits the markdown checklist
  // here, byte-identical to today.
  if (!opts.json) {
    process.stdout.write(renderMarkdown(result));
  }

  // Exit 1 if any findings: lookalikes present, managed files missing, or root dupes detected (#23)
  const hasLookalikes = findings.some(f => !f.present && f.lookalike !== null);
  const hasMissingManaged = (result.drift && result.drift.missing.length > 0) === true;
  const hasRootDupes = rootDupes.length > 0;
  const openExceptions = result.drift?.open_exceptions ?? 0;

  // #349 F16: render the health verdict — one line per aggregated signal.
  // Picks the doctor's "verdict kind" (used by the breadcrumb below) by a
  // scaffold-first priority: scaffold, then root-dupes, then upgrade/repair,
  // then clean — the same structural-integrity-before-version ordering the
  // shared remediation planner (`planRemediation`, ADR-0018) sequences.
  //
  // Pre-adopt mode collapses to a single "Not yet adopted" verdict —
  // saying "✓ All clear" + "run npm run build" while renderMarkdown
  // already says "Run adopt to install the scaffold" is the F9-style
  // contradiction this PR closes for audit. Same shape, doctor edition.
  const verdictLines: string[] = ["## Verdict", ""];
  if (ctx.kind !== "adopted") {
    verdictLines.push("- ⚠ Not yet adopted — `.claude-ds.json` absent");
    if (hasLookalikes) verdictLines.push("- ✗ Lookalikes detected — rename before `adopt`");
    if (hasRootDupes) verdictLines.push(`- ✗ Root-level duplicates: ${rootDupes.length}`);
  } else {
    if (hasLookalikes) verdictLines.push("- ✗ Lookalikes detected — rename or re-adopt");
    if (hasMissingManaged) {
      verdictLines.push(`- ✗ Scaffold gap: ${result.drift?.missing.length ?? 0} managed file(s) missing`);
    }
    if (hasRootDupes) verdictLines.push(`- ✗ Root-level duplicates: ${rootDupes.length}`);
    if (repairNeeded > 0) verdictLines.push(`- ⚠ Repair needed: ${repairNeeded} regressed migration end-state(s)`);
    if (upgradeAvailable) {
      verdictLines.push(`- ⚠ Upgrade available: pinned ${ctx.cfg.packVersion} < installed v${pkg.version}`);
    }
    if (openExceptions > 0) verdictLines.push(`- ℹ Open exceptions: ${openExceptions}`);

    const everythingClean =
      !hasLookalikes &&
      !hasMissingManaged &&
      !hasRootDupes &&
      repairNeeded === 0 &&
      !upgradeAvailable;
    if (everythingClean) verdictLines.push("- ✓ All clear");
  }
  verdictLines.push("");
  // #344: --json is the machine surface — suppress the human verdict block.
  if (!opts.json) process.stdout.write(verdictLines.join("\n"));

  // #349 F21: every command ends with a → Next breadcrumb. Pick the route
  // the same way the verdict ordered the concerns. Scaffold and lookalike
  // issues outrank version concerns — you do not upgrade onto a broken
  // baseline. Pre-adopt routes through `adopt` regardless: even a
  // lookalike rename is a pre-`adopt` step, not a `migrate-layout` (which
  // is an adopted-project remediation).
  const buildCmd = await detectBuildCommand(cwd);
  const verdict: "clean" | "pre-adopt" | "scaffold-gap" | "root-dupes" | "lookalikes" | "repair-needed" | "upgrade-available" =
    ctx.kind !== "adopted" ? "pre-adopt" :
    hasMissingManaged ? "scaffold-gap" :
    hasRootDupes ? "root-dupes" :
    hasLookalikes ? "lookalikes" :
    repairNeeded > 0 ? "repair-needed" :
    upgradeAvailable ? "upgrade-available" :
    "clean";
  // #344: --json suppresses the human → Next breadcrumb too.
  if (!opts.json) printNextStep("doctor", { doctorVerdict: verdict, buildCmd });

  // F16: failing the verdict on upgrade-available or repair-needed would
  // be more aggressive than F16 demands ("not blind to" ≠ "fail the
  // exit"). Keep today's exit-1 gates (lookalikes / scaffold gap / root
  // dupes) — those are project-defect signals — and let upgrade-available
  // / repair-needed surface in the verdict + breadcrumb without flipping
  // the exit code. Tests pin both behaviors.
  const failing = hasLookalikes || hasMissingManaged || hasRootDupes;
  if (failing) {
    if (hasLookalikes) {
      process.stderr.write("If these matches are false positives, re-run with --ignore '<glob>,<glob>'\n");
    }
    if (hasRootDupes) {
      process.stderr.write("Root-level duplicates detected — run `reconcile` to resolve\n");
    }
  }

  // Issue #408: emit the headless contract envelope around the existing
  // DoctorResult shape so a verifying agent can route on `verdict`/`ok`/
  // `exitCode` without reparsing the markdown. Top-level `mode`,
  // `canonical`, `drift`, etc. are preserved for back-compat with PRD
  // #340 sub-issue #344's machine surface (pinned by doctor.test.ts).
  if (opts.json) {
    const exitCode = failing ? 1 : 0;
    const headlessEnvelope = {
      command: "doctor" as const,
      ok: !failing,
      verdict,
      exitCode,
      actions: {},
      remaining: {
        missingManaged: result.drift?.missing ?? [],
        lookalikes: findings.filter(f => !f.present && f.lookalike !== null).length,
        rootDupes: rootDupes.length,
        repairNeeded,
        upgradeAvailable,
        openExceptions,
      },
      ...result,
    };
    process.stdout.write(JSON.stringify(headlessEnvelope, null, 2) + "\n");
    process.exit(exitCode);
  }

  if (failing) {
    process.exit(1);
  }
}
