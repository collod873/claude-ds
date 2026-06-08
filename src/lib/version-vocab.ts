/**
 * Shared vocabulary for the two version axes the CLI surfaces — issue #412.
 *
 * Two distinct things kept being conflated in user-facing copy:
 *   - **CLI version** (`pkg.version`): the installed `claude-ds` binary, what
 *     `npx github:collod873/claude-ds#vX.Y.Z` (or a local `npm link`) resolves
 *     to. Always written `v${pkg.version}`.
 *   - **Pack pin** (`cfg.packVersion`): the `packVersion` field in the
 *     consumer's `.claude-ds.json`, i.e. the migration target the consumer is
 *     pinned to. Only `upgrade` (and `adopt` on first run) mutates this.
 *
 * Before this module, the upgrade / heal / front-door commitment gate header
 * could render `pack v1.0.0 → v1.4.0` while the upgrade body said `pack is at
 * v1.0.0` and nothing migrated — because the header was synthesised from
 * `(packVersion, pkg.version)` without consulting `computeMigrationChain`.
 * When the chain is empty there is no migration; the CLI binary moved but the
 * pack did not. `upgradeHeadline` makes that the only way the headline can be
 * computed, so the phantom `vX → vY` cannot recur.
 *
 * `LABEL_*` constants pin the wording every surface (`version`, `doctor`,
 * `upgrade`, the front-door gate) uses for each axis so they cannot diverge.
 */
import pkg from "../../package.json" with { type: "json" };

/** The consumer's pinned `packVersion` from `.claude-ds.json`. */
export const LABEL_PIN = "pinned";
/** The installed CLI binary version (from this package's `package.json`). */
export const LABEL_CLI = "installed";
/** The pack itself — the migration target the consumer is on. */
export const LABEL_PACK = "pack";

/** The CLI binary version, formatted as `v${pkg.version}`. Single source of
 *  truth so every surface ("installed: …", upgrade target default, etc.) reads
 *  the same string. */
export function cliVersion(): string {
  return `v${pkg.version}`;
}

/**
 * The upgrade-step headline shared by `upgrade` and the front-door / heal
 * commitment gate. Cases:
 *   - `from === to`: nothing to do — only the verification chain runs.
 *     Returned as `verify migration end-states` so the gate header reads
 *     `upgrade — verify migration end-states`.
 *   - `chainLength === 0` and `from !== to`: the CLI is ahead of the pack but
 *     no registered migrations span the gap. Returned as `pin bump only — pack
 *     stays vX`; never `pack vX → vY` (the phantom this module exists to
 *     prevent).
 *   - `chainLength > 0`: a real migration set will apply. Returned as
 *     `pack vX → vY`, matching today's non-empty behaviour.
 */
export function upgradeHeadline(input: {
  from: string;
  to: string;
  chainLength: number;
}): string {
  if (input.from === input.to) return "verify migration end-states";
  if (input.chainLength === 0) return `pin bump only — pack stays ${input.from}`;
  return `${LABEL_PACK} ${input.from} → ${input.to}`;
}
