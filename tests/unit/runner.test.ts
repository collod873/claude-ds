import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { run } from "../../src/lib/runner";
import type { Operation, Change } from "../../src/lib/operation";
import { loadProject, type ProjectContext } from "../../src/lib/project";
import { makeSyncPackFiles } from "../../src/lib/ops/sync-pack-files";
import { cleanup, freshTmpDir } from "../helpers/tmpdir";

function makeCtx(cwd: string): ProjectContext {
  // Runner only consumes ctx.cwd; cast to satisfy the type without booting a real project.
  return { cwd } as unknown as ProjectContext;
}

function writeOp(name: string, changes: Change[]): Operation {
  return { name, plan: async () => changes };
}

let dir: string;
beforeEach(async () => { dir = await freshTmpDir("runner-"); });
afterEach(async () => { await cleanup(dir); });

describe("runner — dry-run", () => {
  it("does not touch disk", async () => {
    await writeFile(join(dir, "existing.txt"), "old");
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "write", path: "existing.txt", before: Buffer.from("old"), after: Buffer.from("new") },
      { kind: "write", path: "new.txt", before: null, after: Buffer.from("hello") },
    ]);
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const report = await run(ctx, [op], "dry-run");
    spy.mockRestore();

    expect(report.applied).toEqual([]);
    expect(await readFile(join(dir, "existing.txt"), "utf8")).toBe("old");
    await expect(stat(join(dir, "new.txt"))).rejects.toThrow();
  });

  it("plan() throwing does not abort other ops", async () => {
    const ctx = makeCtx(dir);
    const bad: Operation = { name: "bad", plan: async () => { throw new Error("boom"); } };
    const good = writeOp("good", [
      { kind: "write", path: "good.txt", before: null, after: Buffer.from("g") },
    ]);
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
      written.push(String(chunk));
      return true;
    }) as any);
    const report = await run(ctx, [bad, good], "dry-run");
    spy.mockRestore();

    expect(report.ops[0]).toMatchObject({ name: "bad", changes: [], error: "boom" });
    expect(report.ops[1]).toMatchObject({ name: "good" });
    expect(report.ops[1].changes).toHaveLength(1);
    expect(written.join("")).toContain("[good] good.txt");
  });
});

describe("runner — apply write", () => {
  it("create — auto-creates parent dirs", async () => {
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "write", path: "nested/sub/file.txt", before: null, after: Buffer.from("hi") },
    ]);
    const report = await run(ctx, [op], "apply");
    expect(report.failed).toBeUndefined();
    expect(report.applied).toHaveLength(1);
    expect(await readFile(join(dir, "nested/sub/file.txt"), "utf8")).toBe("hi");
  });

  it("modify — atomic; .tmp is gone after", async () => {
    await writeFile(join(dir, "f.txt"), "old");
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "write", path: "f.txt", before: Buffer.from("old"), after: Buffer.from("new") },
    ]);
    await run(ctx, [op], "apply");
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("new");
    const entries = await readdir(dir);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });
});

describe("runner — apply delete", () => {
  it("removes existing file", async () => {
    await writeFile(join(dir, "del.txt"), "bye");
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "delete", path: "del.txt", before: Buffer.from("bye") },
    ]);
    const report = await run(ctx, [op], "apply");
    expect(report.failed).toBeUndefined();
    await expect(stat(join(dir, "del.txt"))).rejects.toThrow();
  });

  it("missing file is a no-op", async () => {
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "delete", path: "ghost.txt", before: Buffer.from("") },
    ]);
    const report = await run(ctx, [op], "apply");
    expect(report.failed).toBeUndefined();
    expect(report.applied).toHaveLength(1);
  });
});

describe("runner — apply rename", () => {
  it("non-git — fs.rename", async () => {
    await writeFile(join(dir, "a.txt"), "x");
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "rename", path: "a.txt", after: "b.txt" },
    ]);
    const report = await run(ctx, [op], "apply");
    expect(report.failed).toBeUndefined();
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("x");
    await expect(stat(join(dir, "a.txt"))).rejects.toThrow();
  });

  it("git-tracked — uses git mv, status shows rename (R)", async () => {
    // init git repo
    const opts = { cwd: dir, encoding: "utf8" as const };
    expect(spawnSync("git", ["init", "-q"], opts).status).toBe(0);
    spawnSync("git", ["config", "user.email", "t@t.t"], opts);
    spawnSync("git", ["config", "user.name", "t"], opts);
    spawnSync("git", ["config", "commit.gpgsign", "false"], opts);
    await writeFile(join(dir, "src.txt"), "hello world\nline two\n");
    expect(spawnSync("git", ["add", "src.txt"], opts).status).toBe(0);
    expect(spawnSync("git", ["commit", "-q", "-m", "init"], opts).status).toBe(0);

    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "rename", path: "src.txt", after: "dst.txt" },
    ]);
    const report = await run(ctx, [op], "apply");
    expect(report.failed).toBeUndefined();
    expect(await readFile(join(dir, "dst.txt"), "utf8")).toBe("hello world\nline two\n");

    const status = spawnSync("git", ["status", "--porcelain"], opts);
    // git mv shows as `R  src.txt -> dst.txt` once staged
    expect(status.stdout).toMatch(/^R/m);
    expect(status.stdout).toContain("src.txt");
    expect(status.stdout).toContain("dst.txt");
  });
});

describe("runner — abort change", () => {
  it("dry-run: logs abort reason; no disk touch", async () => {
    await writeFile(join(dir, "f.txt"), "untouched");
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "abort", path: "f.txt", reason: "hand-edited" },
    ]);
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
      written.push(String(chunk));
      return true;
    }) as any);
    const report = await run(ctx, [op], "dry-run");
    spy.mockRestore();

    expect(report.applied).toEqual([]);
    expect(written.join("")).toContain("[op] f.txt (abort: hand-edited)");
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("untouched");
  });

  it("apply: skips file, records in applied, does not fail or block later changes", async () => {
    await writeFile(join(dir, "keep.txt"), "original");
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "abort", path: "keep.txt", reason: "hand-edited" },
      { kind: "write", path: "after.txt", before: null, after: Buffer.from("wrote") },
    ]);
    const report = await run(ctx, [op], "apply");
    expect(report.failed).toBeUndefined();
    expect(report.applied).toHaveLength(2);
    // abort did not touch the file
    expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("original");
    // a later change still ran
    expect(await readFile(join(dir, "after.txt"), "utf8")).toBe("wrote");
  });
});

describe("runner — apply failure handling", () => {
  it("stops on first failure; later changes not applied", async () => {
    // Make a regular file at 'blocker' — then a write whose path is 'blocker/child.txt'
    // will fail because mkdir cannot create a dir over a file.
    await writeFile(join(dir, "blocker"), "i am a file");
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "write", path: "blocker/child.txt", before: null, after: Buffer.from("nope") },
      { kind: "write", path: "ok.txt", before: null, after: Buffer.from("would be ok") },
    ]);
    const report = await run(ctx, [op], "apply");
    expect(report.failed).toBeDefined();
    expect(report.failed!.change.kind).toBe("write");
    expect((report.failed!.change as Extract<Change, { kind: "write" }>).path).toBe("blocker/child.txt");
    expect(report.applied).toHaveLength(0);
    await expect(stat(join(dir, "ok.txt"))).rejects.toThrow();
  });

  it("default (no rollbackOnFailure) leaves already-applied changes on disk", async () => {
    await writeFile(join(dir, "one.txt"), "orig");
    await writeFile(join(dir, "blocker"), "i am a file");
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "write", path: "one.txt", before: Buffer.from("orig"), after: Buffer.from("written") },
      { kind: "write", path: "blocker/child.txt", before: null, after: Buffer.from("nope") },
    ]);
    const report = await run(ctx, [op], "apply");
    expect(report.failed).toBeDefined();
    // First change applied; not rolled back
    expect(await readFile(join(dir, "one.txt"), "utf8")).toBe("written");
  });
});

describe("runner — rollbackOnFailure", () => {
  it("with rollbackOnFailure: true, unwinds applied writes LIFO on later failure", async () => {
    await writeFile(join(dir, "existing.txt"), "orig");
    await writeFile(join(dir, "blocker"), "i am a file");
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "write", path: "existing.txt", before: Buffer.from("orig"), after: Buffer.from("modified") },
      { kind: "write", path: "created.txt", before: null, after: Buffer.from("new") },
      { kind: "write", path: "blocker/child.txt", before: null, after: Buffer.from("fails") },
    ]);
    const report = await run(ctx, [op], "apply", { rollbackOnFailure: true });
    expect(report.failed).toBeDefined();
    expect(report.applied).toHaveLength(0);
    // Modified file restored to original content
    expect(await readFile(join(dir, "existing.txt"), "utf8")).toBe("orig");
    // Created file removed
    await expect(stat(join(dir, "created.txt"))).rejects.toThrow();
  });

  it("with rollbackOnFailure: true, restores deletes by writing the saved bytes back", async () => {
    await writeFile(join(dir, "delete-me.txt"), "saved");
    await writeFile(join(dir, "blocker"), "i am a file");
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "delete", path: "delete-me.txt", before: Buffer.from("saved") },
      { kind: "write", path: "blocker/child.txt", before: null, after: Buffer.from("fails") },
    ]);
    const report = await run(ctx, [op], "apply", { rollbackOnFailure: true });
    expect(report.failed).toBeDefined();
    expect(await readFile(join(dir, "delete-me.txt"), "utf8")).toBe("saved");
  });

  it("with rollbackOnFailure: true, undoes renames", async () => {
    await writeFile(join(dir, "a.txt"), "contents");
    await writeFile(join(dir, "blocker"), "i am a file");
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "rename", path: "a.txt", after: "b.txt" },
      { kind: "write", path: "blocker/child.txt", before: null, after: Buffer.from("fails") },
    ]);
    const report = await run(ctx, [op], "apply", { rollbackOnFailure: true });
    expect(report.failed).toBeDefined();
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("contents");
    await expect(stat(join(dir, "b.txt"))).rejects.toThrow();
  });

  it("with rollbackOnFailure: true and no failure, behaves identically to default", async () => {
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "write", path: "a.txt", before: null, after: Buffer.from("a") },
      { kind: "write", path: "b.txt", before: null, after: Buffer.from("b") },
    ]);
    const report = await run(ctx, [op], "apply", { rollbackOnFailure: true });
    expect(report.failed).toBeUndefined();
    expect(report.applied).toHaveLength(2);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("a");
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("b");
  });
});

describe("runner — Change.mode executable", () => {
  it("write with mode: 'executable' lands as 0o755", async () => {
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "write", path: "hook.sh", before: null, after: Buffer.from("#!/bin/sh\n"), mode: "executable" },
    ]);
    const report = await run(ctx, [op], "apply");
    expect(report.failed).toBeUndefined();
    const s = await stat(join(dir, "hook.sh"));
    expect(s.mode & 0o777).toBe(0o755);
  });

  it("write without mode is unchanged from today (no chmod)", async () => {
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "write", path: "regular.txt", before: null, after: Buffer.from("plain") },
    ]);
    const report = await run(ctx, [op], "apply");
    expect(report.failed).toBeUndefined();
    const s = await stat(join(dir, "regular.txt"));
    // Default file creation mode masked by umask; executable bits must be absent.
    expect(s.mode & 0o111).toBe(0);
  });

  it("modifying an existing file with mode: 'executable' promotes it to 0o755", async () => {
    await writeFile(join(dir, "hook.sh"), "old\n");
    const ctx = makeCtx(dir);
    const op = writeOp("op", [
      { kind: "write", path: "hook.sh", before: Buffer.from("old\n"), after: Buffer.from("new\n"), mode: "executable" },
    ]);
    const report = await run(ctx, [op], "apply");
    expect(report.failed).toBeUndefined();
    const s = await stat(join(dir, "hook.sh"));
    expect(s.mode & 0o777).toBe(0o755);
  });
});

/**
 * PRD #266 capstone: `plan(ctx)` is a pure function of ctx.
 *
 * This is the literal statement the whole effort exists to enable. After
 * Phase A (cwd → ctx), Phase B (auditConfig on ctx), and Phase C (prompts
 * lifted out of plan()), every Operation reads from a frozen ProjectContext
 * and nothing else — so running the same Op twice over the same ctx must
 * yield the same `Change[]`. If it doesn't, the seam ProjectContext is
 * meant to provide is a fiction.
 *
 * Tested in both modes:
 *   - dry-run: drive plan() via the Runner's dry-run path twice; equal.
 *   - apply:   drive plan() via the Runner's apply path on one fixture and
 *              its dry-run path on an identical fixture; the planned
 *              Change[] match — the apply path plans the same thing the
 *              dry-run preview promised.
 *
 * Uses `syncPackFiles` (a real Operation against the real `next-react` pack)
 * so the property is exercised end-to-end across a non-trivial Change[].
 */
describe("runner — plan(ctx) is a pure function of ctx (PRD #266 capstone)", () => {
  let consumerDir: string;
  beforeEach(async () => { consumerDir = await freshTmpDir("plan-pure-"); });
  afterEach(async () => { await cleanup(consumerDir); });

  const CONFIG_JSON = JSON.stringify({
    version: "v0.0.0",
    pack: "next-react",
    mode: "warn",
  });

  it("dry-run: same Op planned twice over a frozen ctx → equal Change[]", async () => {
    await writeFile(join(consumerDir, ".claude-ds.json"), CONFIG_JSON);
    const ctx = await loadProject(consumerDir);
    expect(Object.isFrozen(ctx)).toBe(true);

    const op1 = makeSyncPackFiles();
    const op2 = makeSyncPackFiles();

    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const r1 = await run(ctx, [op1], "dry-run");
    const r2 = await run(ctx, [op2], "dry-run");
    spy.mockRestore();

    expect(r1.ops[0].error).toBeUndefined();
    expect(r2.ops[0].error).toBeUndefined();
    expect(r1.ops[0].changes.length).toBeGreaterThan(0);
    expect(r1.ops[0].changes).toEqual(r2.ops[0].changes);
  });

  it("apply mode plans the same Change[] dry-run would have, over an identical frozen ctx", async () => {
    await writeFile(join(consumerDir, ".claude-ds.json"), CONFIG_JSON);
    const dryRunCtx = await loadProject(consumerDir);
    expect(Object.isFrozen(dryRunCtx)).toBe(true);

    const dryOp = makeSyncPackFiles();
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const dryReport = await run(dryRunCtx, [dryOp], "dry-run");
    spy.mockRestore();

    const applyDir = await freshTmpDir("plan-pure-apply-");
    try {
      await writeFile(join(applyDir, ".claude-ds.json"), CONFIG_JSON);
      const applyCtx = await loadProject(applyDir);
      expect(Object.isFrozen(applyCtx)).toBe(true);

      const applyOp = makeSyncPackFiles();
      const applyReport = await run(applyCtx, [applyOp], "apply");

      expect(dryReport.ops[0].error).toBeUndefined();
      expect(applyReport.ops[0].error).toBeUndefined();
      expect(applyReport.failed).toBeUndefined();
      expect(dryReport.ops[0].changes.length).toBeGreaterThan(0);
      expect(applyReport.ops[0].changes).toEqual(dryReport.ops[0].changes);
    } finally {
      await cleanup(applyDir);
    }
  });
});
