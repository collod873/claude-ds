export function categoryOf(m, path) {
    const e = m.files.find((f) => f.path === path);
    return e ? e.category : null;
}
