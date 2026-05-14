const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
export class TagError extends Error {
}
function parts(tag) {
    const m = tag.match(TAG_RE);
    if (!m)
        throw new TagError(`not a v-prefixed semver: ${tag}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}
export function parseLsRemote(stdout) {
    return stdout
        .split("\n")
        .map((l) => l.split("refs/tags/")[1])
        .filter((t) => !!t && TAG_RE.test(t))
        .sort(cmpSemver);
}
export function cmpSemver(a, b) {
    const pa = parts(a), pb = parts(b);
    for (let i = 0; i < 3; i++) {
        const d = pa[i] - pb[i];
        if (d !== 0)
            return d;
    }
    return 0;
}
export function isMajorBump(from, to) {
    return parts(from)[0] !== parts(to)[0];
}
