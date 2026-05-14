const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

export class TagError extends Error {}

function parts(tag: string): [number, number, number] {
  const m = tag.match(TAG_RE);
  if (!m) throw new TagError(`not a v-prefixed semver: ${tag}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function parseLsRemote(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.split("refs/tags/")[1])
    .filter((t): t is string => !!t && TAG_RE.test(t))
    .sort(cmpSemver);
}

export function cmpSemver(a: string, b: string): number {
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = pa[i] - pb[i];
    if (d !== 0) return d;
  }
  return 0;
}

export function isMajorBump(from: string, to: string): boolean {
  return parts(from)[0] !== parts(to)[0];
}
