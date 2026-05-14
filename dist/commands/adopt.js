import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../lib/manifest.js";
import { mergeJsonKeys } from "../lib/json-merge.js";
import { info, err, confirm } from "../lib/log.js";
import { detectLookalikes } from "../lib/lookalike.js";
// Read package.json for version (avoid JSON import assertions for broader compat).
async function getVersion(packageJsonPath) {
    const raw = await readFile(packageJsonPath, "utf8");
    return JSON.parse(raw).version;
}
async function exists(p) { try {
    await stat(p);
    return true;
}
catch {
    return false;
} }
export async function adoptCmd(opts) {
    const cwd = opts.cwd ?? process.cwd();
    if (await exists(join(cwd, ".claude-ds.json"))) {
        err(".claude-ds.json already exists");
        process.exit(2);
    }
    if (!opts.yes && !(await confirm(`Adopt claude-ds (pack=${opts.pack}, WARN mode) here?`))) {
        info("aborted");
        return;
    }
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "..", "..");
    const packDir = join(repoRoot, "packs", opts.pack);
    const manifest = parseManifest(await readFile(join(packDir, "manifest.json"), "utf8"));
    // Precondition gate: refuse if any canonical path is missing but has a lookalike.
    // This prevents parallel files being seeded next to differently-named existing files.
    const findings = await detectLookalikes(cwd, manifest.canonical_paths);
    const blockers = findings.filter(f => !f.present && f.lookalike !== null);
    if (blockers.length > 0) {
        const lines = [
            "adopt refused: lookalike files detected — rename to canonical names first.",
            "",
            "The following project files use different vocabulary than the canonical names.",
            "Rename them before running adopt (use `doctor` to see the full report):",
            "",
        ];
        for (const b of blockers) {
            lines.push(`  ${b.lookalike} → ${b.canonical}`);
        }
        lines.push("");
        lines.push("No files were modified.");
        process.stderr.write(lines.join("\n") + "\n");
        process.exit(2);
    }
    for (const f of manifest.files) {
        if (f.category === "generated")
            continue;
        const srcName = f.path === "package.json" ? "package.json.seed" : f.path === "CLAUDE.md" ? "CLAUDE.md.fragment" : f.path;
        const dest = resolve(cwd, f.path);
        const cwdResolved = resolve(cwd);
        if (dest !== cwdResolved && !dest.startsWith(cwdResolved + "/")) {
            err(`manifest path escapes project root: ${f.path}`);
            process.exit(2);
        }
        if (f.category === "seeded" && await exists(dest))
            continue;
        const content = await readFile(join(packDir, "files", srcName), "utf8");
        await mkdir(dirname(dest), { recursive: true });
        if (f.category === "hybrid" && f.format === "markdown" && await exists(dest)) {
            const cur = await readFile(dest, "utf8");
            const merged = `${cur}\n<!-- >>> claude-ds managed >>> -->\n${content}\n<!-- <<< claude-ds managed <<< -->\n`;
            await writeFile(dest, merged, "utf8");
        }
        else if (f.category === "hybrid" && f.format === "markdown") {
            await writeFile(dest, `# Project\n<!-- >>> claude-ds managed >>> -->\n${content}\n<!-- <<< claude-ds managed <<< -->\n`, "utf8");
        }
        else if (f.category === "hybrid" && f.format === "json") {
            if (await exists(dest)) {
                const current = await readFile(dest, "utf8");
                const merged = mergeJsonKeys(content, current, ["hooks"]);
                await writeFile(dest, merged, "utf8");
            }
            else {
                await writeFile(dest, content, "utf8");
            }
        }
        else {
            await writeFile(dest, content, "utf8");
        }
    }
    const version = await getVersion(join(repoRoot, "package.json"));
    const cfg = { version: `v${version}`, pack: opts.pack, mode: "warn", enforce_threshold: 10, removed: [] };
    await writeFile(join(cwd, ".claude-ds.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
    info(`adopted claude-ds (${opts.pack}, mode=warn). Run 'enforce' when ready.`);
}
