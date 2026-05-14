export class ExceptionError extends Error {}
export interface Exception { rule_id: string; file: string; reason: string; expiry: string; }
export function parseExceptions(raw: string): Exception[] {
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new ExceptionError("exceptions.json must be an array");
  for (const e of arr) {
    if (typeof e.rule_id !== "string" || typeof e.file !== "string" || typeof e.reason !== "string" || typeof e.expiry !== "string")
      throw new ExceptionError(`malformed exception entry: ${JSON.stringify(e)}`);
    if (!e.reason.trim()) throw new ExceptionError(`reason required for ${e.file}`);
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
