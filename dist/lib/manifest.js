export class ManifestError extends Error {
}
const CATS = new Set(["managed", "seeded", "generated", "hybrid"]);
const FMTS = new Set(["markdown", "shell", "json"]);
export function parseManifest(raw) {
    const o = JSON.parse(raw);
    if (!Array.isArray(o.files))
        throw new ManifestError("files: array required");
    const out = [];
    for (const e of o.files) {
        if (typeof e.path !== "string")
            throw new ManifestError("entry.path: string required");
        if (!CATS.has(e.category))
            throw new ManifestError(`entry.category invalid: ${e.category}`);
        if (e.category === "hybrid") {
            if (!FMTS.has(e.format))
                throw new ManifestError(`hybrid entry missing/invalid format: ${e.path}`);
        }
        const owned_keys = Array.isArray(e.owned_keys)
            ? e.owned_keys.filter((k) => typeof k === "string")
            : undefined;
        out.push({ path: e.path, category: e.category, format: e.format, owned_keys });
    }
    const canonical_paths = Array.isArray(o.canonical_paths)
        ? o.canonical_paths.filter((p) => typeof p === "string")
        : [];
    const lookalike_ignore = Array.isArray(o.lookalike_ignore)
        ? o.lookalike_ignore.filter((p) => typeof p === "string")
        : [];
    return { files: out, canonical_paths, lookalike_ignore };
}
