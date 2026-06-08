/**
 * Issue #370 — the five previously unexercised commands (`version`,
 * `migrate`, `migrate-layout`, `reconform`, `enforce`) used to emit plain
 * `console.log` / `info()` lines with no TTY-gated color and no spinner for
 * the multi-second waits. The fix:
 *
 *   1. routes their phase headers / verdict lines through the `colors()`
 *      adapter exported from `lib/log.ts` (picocolors on TTY, identity off),
 *      so the byte stream off-TTY (the agent surface) stays unchanged but a
 *      live terminal picks up the same color band the dashboard already uses;
 *   2. wraps reconform's long-running `tsc --noEmit` verification (and the
 *      check-script spawn block) in `createProgress()` so the operator sees
 *      live progress instead of a silent pause.
 *
 * This is a structural test — `runCli` spawns a non-TTY subprocess, so we
 * can't observe colored bytes in an integration test. The contract pinned
 * here is the wiring: each command's source must import `colors` from the
 * log module, and reconform must also import `createProgress` and surround
 * the `tsc --noEmit` call with a `progress.start(...)` for the verification
 * phase.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cmdDir = join(here, "..", "..", "src", "commands");

const FIVE_UNEXERCISED = [
  "version.ts",
  "migrate.ts",
  "migrate-layout.ts",
  "reconform.ts",
  "enforce.ts",
];

describe("#370 — five unexercised commands wire the TTY color adapter", () => {
  it.each(FIVE_UNEXERCISED)(
    "%s imports `colors` from lib/log.js so phase/verdict lines colorize on TTY",
    async (filename) => {
      const src = await readFile(join(cmdDir, filename), "utf8");
      // Import statement: `import { ..., colors, ... } from "../lib/log.js"`.
      // The regex is tolerant of the other named imports beside `colors`.
      const importRe = /import\s*\{[^}]*\bcolors\b[^}]*\}\s*from\s*["']\.\.\/lib\/log\.js["']/;
      expect(src, `${filename} should import colors from lib/log.js`).toMatch(importRe);
      // The adapter must actually be invoked — an unused import is the F1
      // shape the issue is closing (wiring named but never reached).
      expect(src, `${filename} should call colors() at least once`).toMatch(/\bcolors\(\)/);
    },
  );
});

describe("#370 — reconform surfaces a spinner around the multi-second waits", () => {
  it("imports createProgress from the TTY layer", async () => {
    const src = await readFile(join(cmdDir, "reconform.ts"), "utf8");
    expect(src).toMatch(
      /import\s*\{[^}]*\bcreateProgress\b[^}]*\}\s*from\s*["']\.\.\/lib\/render\/tty-layer\.js["']/,
    );
  });

  it("wraps `tsc --noEmit` with a dedicated progress.start phase", async () => {
    const src = await readFile(join(cmdDir, "reconform.ts"), "utf8");
    // The spinner phase header naming `tsc` must appear before the
    // `tsc --noEmit` spawn so the operator sees "verifying moves" rather than
    // a silent hang during the multi-second tsc run.
    const tscSpawnIdx = src.indexOf('spawnSync("npx", ["tsc", "--noEmit"]');
    expect(tscSpawnIdx).toBeGreaterThan(-1);
    const prelude = src.slice(0, tscSpawnIdx);
    expect(prelude).toMatch(/progress\.start\([^)]*tsc[^)]*\)/);
  });

  it("starts and stops the spinner in a try/finally so SIGINT cleanup runs", async () => {
    const src = await readFile(join(cmdDir, "reconform.ts"), "utf8");
    // The progress controller registers a SIGINT handler that gets removed in
    // stop(); reconform must invoke stop() unconditionally or the agent-side
    // process keeps a dangling listener after the command returns.
    expect(src).toMatch(/progress\.stop\(\)/);
    // `try {` must precede the first `progress.start` so the `finally { progress.stop() }`
    // covers every phase.
    const firstStartIdx = src.indexOf("progress.start(");
    const tryIdx = src.lastIndexOf("try {", firstStartIdx);
    expect(tryIdx).toBeGreaterThan(-1);
    expect(tryIdx).toBeLessThan(firstStartIdx);
  });
});
