export class MarkerError extends Error {
}
const PAIRS = {
    markdown: ["<!-- >>> claude-ds managed >>> -->", "<!-- <<< claude-ds managed <<< -->"],
    shell: ["# >>> claude-ds managed >>>", "# <<< claude-ds managed <<<"],
};
export function mergeMarkers(current, desiredInner, fmt) {
    const [open, close] = PAIRS[fmt];
    const opens = [...current.matchAll(new RegExp(escapeRe(open), "g"))];
    const closes = [...current.matchAll(new RegExp(escapeRe(close), "g"))];
    if (opens.length !== 1 || closes.length !== 1)
        throw new MarkerError(`expected exactly one marker pair (open=${opens.length}, close=${closes.length})`);
    const openEnd = opens[0].index + open.length;
    const closeStart = closes[0].index;
    if (closeStart < openEnd)
        throw new MarkerError("close before open");
    return current.slice(0, openEnd) + `\n${desiredInner}\n` + current.slice(closeStart);
}
export function extractMarkerInner(current, fmt) {
    const [open, close] = PAIRS[fmt];
    const i = current.indexOf(open), j = current.indexOf(close);
    if (i < 0 || j < 0 || j < i)
        throw new MarkerError("missing or malformed markers");
    return current.slice(i + open.length, j).replace(/^\n|\n$/g, "");
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
