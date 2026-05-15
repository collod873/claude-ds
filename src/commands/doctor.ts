import { readFile, stat, writeFile, mkdir, rm, readdir, copyFile, chmod } from "node:fs/promises";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseManifest } from "../lib/manifest.js";
import { parseConfig } from "../lib/config.js";
import { parseExceptions, openCount } from "../lib/exceptions.js";
import { detectLookalikes, Finding } from "../lib/lookalike.js";
import { detectPackageManager, PackageManager } from "../lib/package-manager.js";

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
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

export async function doctorCmd(opts: { pack: string; ignore?: string; cwd?: string; verifyHooks?: boolean }): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const packDir = join(repoRoot, "packs", opts.pack);

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
  const canonicalPaths = manifest.canonical_paths;

  // Load ignore globs from on-disk config (if present), then merge with --ignore flag globs.
  // Order: pack defaults < project config < --ignore flag (project/flag extend, not replace).
  const configPath = join(cwd, ".claude-ds.json");
  let configIgnore: string[] = [];
  if (await exists(configPath)) {
    try {
      const cfg = parseConfig(await readFile(configPath, "utf8"));
      configIgnore = cfg.lookalike_ignore;
    } catch {
      // parseConfig will error properly later; don't block doctor on it here
    }
  }
  const flagGlobs = opts.ignore ? opts.ignore.split(",").map(g => g.trim()).filter(Boolean) : [];
  const ignoreGlobs = [...manifest.lookalike_ignore, ...configIgnore, ...flagGlobs];

  const findings = await detectLookalikes(cwd, canonicalPaths, ignoreGlobs);
  const pm = await detectPackageManager(cwd);

  const isPostAdopt = await exists(configPath);

  let result: DoctorResult;

  if (isPostAdopt) {
    // Post-adopt: check drift (missing managed files + exception count)
    const cfg = parseConfig(await readFile(configPath, "utf8"));
    let openExceptions = 0;
    const exceptionsPath = join(cwd, "design-system/exceptions.json");
    if (await exists(exceptionsPath)) {
      try {
        const ex = parseExceptions(await readFile(exceptionsPath, "utf8"));
        openExceptions = openCount(ex, new Date());
      } catch {
        // Seeded exceptions.json may be empty/stub — treat as 0 exceptions
        openExceptions = 0;
      }
    }

    // Check which managed files are missing
    const managedPaths = manifest.files
      .filter(f => f.category === "managed")
      .map(f => f.path);
    const missingManaged: string[] = [];
    for (const p of managedPaths) {
      if (!(await exists(join(cwd, p)))) missingManaged.push(p);
    }

    result = {
      mode: "post-adopt",
      canonical: findings,
      drift: {
        missing: missingManaged,
        open_exceptions: openExceptions,
      },
      packageManager: pm,
    };

    // Suppress unused variable warning
    void cfg;
  } else {
    result = {
      mode: "pre-adopt",
      canonical: findings,
      packageManager: pm,
    };
  }

  const md = renderMarkdown(result);
  const json = JSON.stringify(result, null, 2);
  const output = `${md}\n\`\`\`json\n${json}\n\`\`\`\n`;

  process.stdout.write(output);

  // Exit 1 if any findings: lookalikes present or (post-adopt) managed files missing
  const hasLookalikes = findings.some(f => !f.present && f.lookalike !== null);
  const hasMissingManaged = result.drift && result.drift.missing.length > 0;

  if (hasLookalikes || hasMissingManaged) {
    if (hasLookalikes) {
      process.stderr.write("If these matches are false positives, re-run with --ignore '<glob>,<glob>'\n");
    }
    process.exit(1);
  }
}
