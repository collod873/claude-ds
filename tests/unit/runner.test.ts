import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { run } from "../../src/lib/runner";
import type { Operation, Change } from "../../src/lib/operation";
import type { ProjectContext } from "../../src/lib/project";
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
});
