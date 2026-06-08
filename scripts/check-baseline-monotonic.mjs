#!/usr/bin/env node
// #442 (AC4) — mechanical monotonicity guard for the friction baseline ratchet.
//
// The ratchet's social contract (friction-gate.ts, friction-baseline.json) is:
// baseline keys shrink. Adding a key is how someone would silence a real friction
// regression instead of fixing it — so additions must be MECHANICALLY gated, not
// just documented.
//
// The ONE legitimate reason to add a key is day-one red on NEWLY-MEASURED surface
// (e.g. widening the gate's command sequence past the adopt journey surfaces
// friction those commands always had — PRD #439 "RED on day one is intended").
// To keep that path open WITHOUT reopening the silence-a-regression hole, the
// guard aligns with ADR-0003 (the completeness principle: workarounds are tracked
// defects WITH removal triggers, never undocumented patches): an added key is
// allowed IFF it carries an entry in the baseline's `_removal_triggers` map. An
// added key with NO removal trigger is an undocumented silencing ⇒ FAIL. This
// raises the bar (every addition is a reviewable, trigger-backed tracked defect)
// rather than lowering it.
//
// This script diffs the CURRENT `tests/e2e/friction-baseline.json` key set
// against the same file on the base ref (default `origin/main`). It FAILS (exit 1)
// iff the current set has GAINED any key that lacks a `_removal_triggers` entry.
// Removals are always fine. Absent-on-base (first introduction of the file, or no
// base ref reachable) means nothing to compare against ⇒ PASS.
//
// Wired into the blocking smoke tier (.github/workflows/e2e-smoke.yml) as its own
// step and runnable locally via `npm run baseline:check`.
//
// Base ref override: `BASE_REF=origin/some-branch npm run baseline:check`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { argv, env, exit } from "node:process";

const BASELINE_PATH = "tests/e2e/friction-baseline.json";
const BASE_REF = env.BASE_REF || "origin/main";

/** Parse a baseline JSON blob into a Set of keys. Tolerates a malformed/empty blob. */
function keysFrom(raw) {
  if (raw == null) return null; // signal: absent on base
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`baseline:check — could not parse baseline JSON: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.keys)) {
    throw new Error(`baseline:check — malformed baseline (expected { keys: string[] })`);
  }
  return new Set(parsed.keys);
}

/** Read the baseline as it exists on the base ref, or null if not present there. */
function baseKeys(ref) {
  try {
    const raw = execFileSync("git", ["show", `${ref}:${BASELINE_PATH}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return keysFrom(raw);
  } catch {
    // `git show` fails when the ref is unreachable (shallow/first-run CI) OR the
    // file did not exist on that ref. Either way: nothing to compare ⇒ pass.
    return null;
  }
}

/** Pure core: which keys were added in `current` relative to `base`. */
export function addedKeys(base, current) {
  if (base === null) return []; // no base ⇒ nothing added
  return [...current].filter((k) => !base.has(k));
}

/**
 * Pure core: which added keys are UNTRACKED — added relative to base AND lacking
 * a removal trigger. These are the only additions the guard rejects; a tracked
 * addition (day-one red on newly-measured surface, with a documented trigger) is
 * allowed. `triggers` is the set of keys present in `_removal_triggers`.
 */
export function untrackedAddedKeys(base, current, triggers) {
  return addedKeys(base, current).filter((k) => !triggers.has(k));
}

/** Parse the `_removal_triggers` map keys from a baseline blob into a Set. */
function triggersFrom(raw) {
  const parsed = JSON.parse(raw);
  const map = parsed && typeof parsed._removal_triggers === "object" && parsed._removal_triggers
    ? parsed._removal_triggers
    : {};
  return new Set(Object.keys(map));
}

function main() {
  const currentRaw = readFileSync(BASELINE_PATH, "utf8");
  const current = keysFrom(currentRaw);
  const triggers = triggersFrom(currentRaw);
  const base = baseKeys(BASE_REF);

  if (base === null) {
    console.log(
      `baseline:check — no baseline on ${BASE_REF} (first introduction or base unreachable); nothing to compare. PASS.`,
    );
    return;
  }

  const untracked = untrackedAddedKeys(base, current, triggers);
  if (untracked.length > 0) {
    console.error(
      `baseline:check — FAIL: ${untracked.length} UNDOCUMENTED key(s) ADDED to ${BASELINE_PATH} vs ${BASE_REF}.\n` +
        `The friction baseline ratchet only accepts an added key when it carries a\n` +
        `\`_removal_triggers\` entry (day-one red on newly-measured surface — ADR-0003).\n` +
        `An added key with no trigger silences a real regression instead of fixing it. Offending keys:\n` +
        untracked.map((k) => `  + ${k}`).join("\n") +
        `\n\nEither fix the underlying friction (see docs/agents/friction-loop.md) or, if this is\n` +
        `genuinely new measured surface, add a \`_removal_triggers\` entry stating what burns it down.`,
    );
    exit(1);
  }

  const trackedAdds = addedKeys(base, current).length;
  const removed = [...base].filter((k) => !current.has(k)).length;
  console.log(
    `baseline:check — OK: 0 undocumented keys added vs ${BASE_REF}` +
      (trackedAdds > 0 ? ` (${trackedAdds} trigger-backed addition(s) — newly-measured surface)` : ``) +
      (removed > 0 ? ` (${removed} removed — ratchet tightened)` : ``) +
      `.`,
  );
}

// Only run when invoked directly, so the pure `addedKeys` can be imported in tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main();
}
