import { writeFile, readFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
export async function safeWrite(path, content, opts) {
    if (!opts.overwrite) {
        try {
            await stat(path);
            throw new Error(`refusing to overwrite: ${path}`);
        }
        catch (e) {
            if (e.code !== "ENOENT")
                throw e;
        }
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
}
export async function backupTo(path, suffix) {
    await rename(path, `${path}.${suffix}`);
}
export async function readIfExists(path) {
    try {
        return await readFile(path, "utf8");
    }
    catch (e) {
        if (e.code === "ENOENT")
            return null;
        throw e;
    }
}
