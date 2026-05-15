export class ExceptionError extends Error {
}
export function parseExceptions(raw) {
    const parsed = JSON.parse(raw);
    // Accept wrapped shape { exceptions: [...] } — reject bare array (old format).
    if (Array.isArray(parsed))
        throw new ExceptionError("exceptions.json must use wrapped shape { \"exceptions\": [...] }");
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.exceptions))
        throw new ExceptionError("exceptions.json must have an \"exceptions\" array");
    const arr = parsed.exceptions;
    for (const e of arr) {
        if (typeof e.rule_id !== "string" || typeof e.file !== "string" || typeof e.reason !== "string" || typeof e.expiry !== "string")
            throw new ExceptionError(`malformed exception entry: ${JSON.stringify(e)}`);
        if (!e.reason || !(String(e.reason)).trim())
            throw new ExceptionError(`reason required for ${e.file}`);
    }
    return arr;
}
export function openCount(ex, now) {
    return ex.filter((e) => new Date(e.expiry) > now).length;
}
export function gate(ex, threshold, now) {
    const n = openCount(ex, now);
    if (n > threshold)
        throw new ExceptionError(`open exceptions (${n}) exceed threshold (${threshold})`);
}
