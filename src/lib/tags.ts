const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
export function parseLsRemote(stdout: string): string[] {
  return stdout.split("\n").map((l) => l.split("refs/tags/")[1]).filter((t): t is string => !!t && TAG_RE.test(t)).sort(cmpSemver);
}
export function cmpSemver(a: string, b: string): number {
  const ma = a.match(TAG_RE)!, mb = b.match(TAG_RE)!;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]); if (d !== 0) return d;
  }
  return 0;
}
export function isMajorBump(from: string, to: string): boolean {
  return from.match(TAG_RE)![1] !== to.match(TAG_RE)![1];
}
