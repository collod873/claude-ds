export class ExceptionError extends Error {}
export interface Exception { rule_id: string; file: string; reason: string; expiry: string; }
export function parseExceptions(raw: string): Exception[] {
  const parsed = JSON.parse(raw);
  // Accept wrapped shape { exceptions: [...] } — reject bare array (old format).
  if (Array.isArray(parsed)) throw new ExceptionError("exceptions.json must use wrapped shape { \"exceptions\": [...] }");
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.exceptions))
    throw new ExceptionError("exceptions.json must have an \"exceptions\" array");
  const arr: unknown[] = parsed.exceptions;
  for (const e of arr) {
    if (typeof (e as Record<string, unknown>).rule_id !== "string" || typeof (e as Record<string, unknown>).file !== "string" || typeof (e as Record<string, unknown>).reason !== "string" || typeof (e as Record<string, unknown>).expiry !== "string")
      throw new ExceptionError(`malformed exception entry: ${JSON.stringify(e)}`);
    if (!(e as Record<string, unknown>).reason || !(String((e as Record<string, unknown>).reason)).trim()) throw new ExceptionError(`reason required for ${(e as Record<string, unknown>).file}`);
  }
  return arr as Exception[];
}
export function openCount(ex: Exception[], now: Date): number {
  return ex.filter((e) => new Date(e.expiry) > now).length;
}
export function gate(ex: Exception[], threshold: number, now: Date): void {
  const n = openCount(ex, now);
  if (n > threshold) throw new ExceptionError(`open exceptions (${n}) exceed threshold (${threshold})`);
}
