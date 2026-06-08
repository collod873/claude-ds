#!/usr/bin/env node
// #442 (AC4) — mechanical monotonicity guard for the friction baseline ratchet.
//
// The ratchet's social contract (friction-gate.ts, friction-baseline.json) is:
// baseline keys may only be REMOVED across commits, never ADDED. Adding a key is
// how someone would silence a real friction regression instead of fixing it — so
// "keys only shrink" must be MECHANICALLY enforced, not just documented.
//
// This script diffs the CURRENT `tests/e2e/friction-baseline.json` key set
// against the same file on the base ref (default `origin/main`). It FAILS (exit 1)
// iff the current set has GAINED any key relative to base. Removals are always
// fine. Absent-on-base (first introduction of the file, or no base ref reachable)
// means nothing to compare against ⇒ PASS.
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

function main() {
  const current = keysFrom(readFileSync(BASELINE_PATH, "utf8"));
  const base = baseKeys(BASE_REF);

  if (base === null) {
    console.log(
      `baseline:check — no baseline on ${BASE_REF} (first introduction or base unreachable); nothing to compare. PASS.`,
    );
    return;
  }

  const added = addedKeys(base, current);
  if (added.length > 0) {
    console.error(
      `baseline:check — FAIL: ${added.length} key(s) ADDED to ${BASELINE_PATH} vs ${BASE_REF}.\n` +
        `The friction baseline is a one-way ratchet: keys may only be REMOVED, never added.\n` +
        `Adding a key silences a real regression instead of fixing it. Added keys:\n` +
        added.map((k) => `  + ${k}`).join("\n") +
        `\n\nFix the underlying friction (see docs/agents/friction-loop.md), don't widen the baseline.`,
    );
    exit(1);
  }

  const removed = [...base].filter((k) => !current.has(k)).length;
  console.log(
    `baseline:check — OK: 0 keys added vs ${BASE_REF}` +
      (removed > 0 ? ` (${removed} removed — ratchet tightened).` : `.`),
  );
}

// Only run when invoked directly, so the pure `addedKeys` can be imported in tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main();
}
