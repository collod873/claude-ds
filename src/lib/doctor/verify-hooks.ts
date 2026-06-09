import { readFile, stat, writeFile, mkdir, rm, readdir, copyFile, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
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

export interface HookVerifyResult {
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

export async function verifyHooks(packDir: string, cwd: string): Promise<HookVerifyResult[]> {
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

export function renderVerifyTable(results: HookVerifyResult[]): string {
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
