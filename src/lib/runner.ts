import { mkdir, rename, unlink, writeFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ProjectContext } from "./project.js";
import type { Change, Operation } from "./operation.js";

export type RunMode = "dry-run" | "apply";

export interface RunReport {
  ops: { name: string; changes: Change[]; error?: string }[];
  applied: Change[];
  failed?: { change: Change; error: string };
}

function resolveIn(cwd: string, p: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
}

function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function renderDiff(opName: string, c: Change): string {
  const header = `[${opName}] ${c.kind === "rename" ? `${c.path} -> ${c.after}` : c.path}`;
  const lines: string[] = [];
  if (c.kind === "write") {
    if (c.before === null) {
      lines.push(`${header} (create)`);
      if (isBinary(c.after)) {
        lines.push(`[binary content, 0 bytes -> ${c.after.length} bytes]`);
      } else {
        for (const l of c.after.toString("utf8").split("\n")) lines.push(`+${l}`);
      }
    } else {
      lines.push(`${header} (modify)`);
      if (isBinary(c.before) || isBinary(c.after)) {
        lines.push(`[binary content, ${c.before.length} bytes -> ${c.after.length} bytes]`);
      } else {
        const beforeLines = c.before.toString("utf8").split("\n");
        const afterLines = c.after.toString("utf8").split("\n");
        for (const l of beforeLines) lines.push(`-${l}`);
        for (const l of afterLines) lines.push(`+${l}`);
      }
    }
  } else if (c.kind === "delete") {
    lines.push(`${header} (delete)`);
    if (isBinary(c.before)) {
      lines.push(`[binary content, ${c.before.length} bytes -> 0 bytes]`);
    } else {
      for (const l of c.before.toString("utf8").split("\n")) lines.push(`-${l}`);
    }
  } else {
    lines.push(`${header} (rename)`);
  }
  return lines.join("\n");
}

function isGitTracked(cwd: string, relPath: string): boolean {
  const r = spawnSync("git", ["ls-files", "--error-unmatch", relPath], { cwd, stdio: "ignore" });
  return r.status === 0;
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function applyChange(ctx: ProjectContext, c: Change): Promise<void> {
  if (c.kind === "write") {
    const abs = resolveIn(ctx.cwd, c.path);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp`;
    await writeFile(tmp, c.after);
    await rename(tmp, abs);
  } else if (c.kind === "delete") {
    const abs = resolveIn(ctx.cwd, c.path);
    try {
      await unlink(abs);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  } else {
    const absFrom = resolveIn(ctx.cwd, c.path);
    const absTo = resolveIn(ctx.cwd, c.after);
    await mkdir(dirname(absTo), { recursive: true });
    const gitDir = join(ctx.cwd, ".git");
    if (await exists(gitDir) && isGitTracked(ctx.cwd, c.path)) {
      const r = spawnSync("git", ["mv", c.path, c.after], { cwd: ctx.cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git mv failed: ${r.stderr || r.stdout}`);
    } else {
      await rename(absFrom, absTo);
    }
  }
}

/**
 * Run a list of Operations against a ProjectContext.
 *
 * Planning is best-effort: if one Op's `plan()` throws, the error is recorded on
 * that Op's report entry and the remaining Ops still plan. Apply is best-effort
 * and **non-transactional**: Changes apply in order until one fails, at which
 * point `failed` is set and the remaining Changes are skipped. Already-applied
 * Changes are NOT rolled back.
 *
 * In `dry-run` mode no disk mutations occur; a unified-ish diff per Change is
 * written to stdout, prefixed `[op-name] path` so the user can trace authorship.
 */
export async function run(
  ctx: ProjectContext,
  ops: Operation[],
  mode: RunMode,
): Promise<RunReport> {
  const report: RunReport = { ops: [], applied: [] };

  // Plan phase
  const planned: { opName: string; change: Change }[] = [];
  for (const op of ops) {
    try {
      const changes = await op.plan(ctx);
      report.ops.push({ name: op.name, changes });
      for (const change of changes) planned.push({ opName: op.name, change });
    } catch (e) {
      report.ops.push({ name: op.name, changes: [], error: (e as Error).message });
    }
  }

  if (mode === "dry-run") {
    for (const { opName, change } of planned) {
      process.stdout.write(renderDiff(opName, change) + "\n");
    }
    return report;
  }

  // Apply phase
  for (const { change } of planned) {
    try {
      await applyChange(ctx, change);
      report.applied.push(change);
    } catch (e) {
      report.failed = { change, error: (e as Error).message };
      return report;
    }
  }
  return report;
}

// Re-export for callers that want a single import surface.
export type { Change, Operation } from "./operation.js";
