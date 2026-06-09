/**
 * Pure version-currency comparison. Consumed by `version --check` and by
 * the dashboard brain (which surfaces an `upgrade-available` signal and recommends
 * `claude-ds upgrade` when the pinned `packVersion` lags the installed
 * CLI). Keeping the comparison in one place means the dashboard and
 * `version --check` can never disagree about whether a project is stale.
 */

export interface VersionCurrencyInput {
  /** The consumer's pinned `packVersion` from `.claude-ds.json`. */
  pinned: string;
  /** The installed CLI's version (from `package.json`). */
  installed: string;
}

export interface VersionCurrency {
  pinned: string;
  installed: string;
  /** True iff pinned < installed. False when equal or pinned is newer. */
  upgradeAvailable: boolean;
}

function parseSemver(v: string): [number, number, number] {
  const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

export function semverLt(a: string, b: string): boolean {
  const [a1, a2, a3] = parseSemver(a);
  const [b1, b2, b3] = parseSemver(b);
  if (a1 !== b1) return a1 < b1;
  if (a2 !== b2) return a2 < b2;
  return a3 < b3;
}

export function checkVersionCurrency(input: VersionCurrencyInput): VersionCurrency {
  return {
    pinned: input.pinned,
    installed: input.installed,
    upgradeAvailable: semverLt(input.pinned, input.installed),
  };
}
