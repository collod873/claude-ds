import { writeFile, readFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
export async function safeWrite(path: string, content: string, opts: { overwrite: boolean }): Promise<void> {
  if (!opts.overwrite) {
    try { await stat(path); throw new Error(`refusing to overwrite: ${path}`); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
export async function backupTo(path: string, suffix: string): Promise<void> {
  await rename(path, `${path}.${suffix}`);
}
export async function readIfExists(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
}
