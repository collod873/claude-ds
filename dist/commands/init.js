import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { confirm, info, err } from "../lib/log.js";
// Read package.json for version (avoid JSON import assertions for broader compat).
async function getVersion(packageJsonPath) {
    const raw = await readFile(packageJsonPath, "utf8");
    return JSON.parse(raw).version;
}
export async function initCmd(opts) {
    const cwd = opts.cwd ?? process.cwd();
    try {
        await stat(join(cwd, ".claude-ds.json"));
        err(".claude-ds.json already exists");
        process.exit(2);
    }
    catch (e) {
        if (e.code !== "ENOENT")
            throw e;
    }
    if (!opts.yes && !(await confirm(`Initialize claude-ds with pack '${opts.pack}' here?`))) {
        info("aborted");
        return;
    }
    // Resolve packs dir from this file's location, walking up from src/commands or dist/commands to repo root.
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "..", "..");
    const packDir = join(repoRoot, "packs", opts.pack);
    const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
    for (const f of manifest.files) {
        if (f.category === "generated")
            continue;
        const srcName = f.path === "package.json" ? "package.json.seed" :
            f.path === "CLAUDE.md" ? "CLAUDE.md.fragment" :
                f.path;
        const src = join(packDir, "files", srcName);
        const dest = join(cwd, f.path);
        await mkdir(dirname(dest), { recursive: true });
        const content = await readFile(src, "utf8");
        if (f.category === "hybrid" && f.format === "markdown") {
            const wrapped = `# Project CLAUDE.md\n\n<!-- >>> claude-ds managed >>> -->\n${content}\n<!-- <<< claude-ds managed <<< -->\n`;
            await writeFile(dest, wrapped, "utf8");
        }
        else {
            await writeFile(dest, content, "utf8");
        }
    }
    const version = await getVersion(join(repoRoot, "package.json"));
    const cfg = { version: `v${version}`, pack: opts.pack, mode: "block", enforce_threshold: 10, removed: [] };
    await writeFile(join(cwd, ".claude-ds.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
    info(`initialized claude-ds (${opts.pack} @ v${version}, mode=block)`);
}
