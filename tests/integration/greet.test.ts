/**
 * PRD #325 sub-issue #334 — end-to-end behavior of the first-run greet.
 *
 * The greet fires from bare `claude-ds` whenever no `.claude-ds.json` exists.
 * These tests pin every cell of the resolver matrix at the CLI boundary:
 *
 *   - non-TTY + no `--answers`  → fail loud naming the Decision id (exit 2)
 *   - non-TTY + `--answers: 0`  → dispatches to adopt in-process
 *   - non-TTY + `--answers: 1`  → dispatches to init in-process
 *   - non-TTY + config exists   → greet is skipped; today's help output
 *   - TTY     + injected prompt → dispatches based on the prompt's answer
 *
 * The TTY branch uses a direct `greetCmd` call with an injected prompt rather
 * than poking `process.stdout.isTTY` — same pattern the front-door integration
 * test uses for `interactive: false`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freshTmpDir, cleanup } from "../helpers/tmpdir";
import { runCli } from "../helpers/runcli";
import { greetCmd } from "../../src/commands/greet";
import {
  GREET_ADOPT_INDEX,
  GREET_DECISION_ID,
  GREET_INIT_INDEX,
} from "../../src/lib/first-run";

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function writeNextReactPkg(dir: string): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify({
    name: "fixture",
    dependencies: { next: "14.0.0", react: "18.0.0", "react-dom": "18.0.0" },
  }));
}

describe("first-run greet — non-TTY at the CLI boundary", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("no .claude-ds.json + no --answers → fails loud naming the Decision", async () => {
    const r = await runCli([], { cwd: dir });
    expect(r.code).not.toBe(0);
    // The error must name the Decision id so the operator knows what key to
    // put in `--answers`. ADR-0023's fail-loud contract — no silent default.
    expect(r.stderr).toContain(GREET_DECISION_ID);
    // And the .claude-ds.json must NOT have been silently written.
    expect(await exists(join(dir, ".claude-ds.json"))).toBe(false);
  });

  it("--answers selecting init dispatches to init (writes .claude-ds.json)", async () => {
    const answersFile = join(dir, "answers.json");
    await writeFile(answersFile, JSON.stringify({ [GREET_DECISION_ID]: GREET_INIT_INDEX }));

    const r = await runCli(["--answers", answersFile], { cwd: dir });
    expect(r.code).toBe(0);

    // init's signature: writes `.claude-ds.json` and a starter set of pack files.
    const cfgPath = join(dir, ".claude-ds.json");
    expect(await exists(cfgPath)).toBe(true);
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    expect(cfg.pack).toBe("next-react");
  });

  it("--answers selecting adopt dispatches to adopt (writes .claude-ds.json)", async () => {
    // adopt requires a recognizable consumer tree; supply package.json so the
    // greet's framework detection picks `next-react`, and add a placeholder
    // component so the brownfield branch fires.
    await writeNextReactPkg(dir);
    await mkdir(join(dir, "components"), { recursive: true });
    await writeFile(
      join(dir, "components/Button.tsx"),
      "export const Button = () => null;\n",
    );

    const answersFile = join(dir, "answers.json");
    await writeFile(answersFile, JSON.stringify({ [GREET_DECISION_ID]: GREET_ADOPT_INDEX }));

    const r = await runCli(["--answers", answersFile], { cwd: dir });
    expect(r.code).toBe(0);

    // adopt's signature: writes `.claude-ds.json` with mode "warn".
    const cfgPath = join(dir, ".claude-ds.json");
    expect(await exists(cfgPath)).toBe(true);
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    expect(cfg.pack).toBe("next-react");
    expect(cfg.mode).toBe("warn");
  });

  it("--answers with deferred answer → fails loud (no silent dispatch)", async () => {
    const answersFile = join(dir, "answers.json");
    await writeFile(answersFile, JSON.stringify({ [GREET_DECISION_ID]: "defer" }));

    const r = await runCli(["--answers", answersFile], { cwd: dir });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(GREET_DECISION_ID);
    expect(await exists(join(dir, ".claude-ds.json"))).toBe(false);
  });

  it("config present → greet is skipped (today's help output)", async () => {
    // PRD #325 acceptance: when `.claude-ds.json` exists, the greet is
    // skipped and bare `claude-ds` runs the dashboard front door. Non-TTY
    // keeps today's commander-help behavior.
    await writeFile(join(dir, ".claude-ds.json"), JSON.stringify({
      packVersion: "v0.8.0",
      pack: "next-react",
      mode: "warn",
      app_dir: "app",
      claude_md_target: ".claude/CLAUDE.md",
    }));

    const r = await runCli([], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage:\s*claude-ds/);
    // Greet's fail-loud message must not appear when config is present.
    expect(r.stderr).not.toContain(GREET_DECISION_ID);
  });
});

describe("first-run greet — TTY arm with injected prompt", () => {
  let dir: string;
  beforeEach(async () => { dir = await freshTmpDir(); });
  afterEach(async () => { await cleanup(dir); });

  it("TTY prompt returning init's index dispatches to init", async () => {
    await greetCmd({
      cwd: dir,
      isTTYOverride: true,
      prompt: async () => GREET_INIT_INDEX,
    });
    expect(await exists(join(dir, ".claude-ds.json"))).toBe(true);
    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.pack).toBe("next-react");
  });

  it("TTY prompt returning adopt's index dispatches to adopt", async () => {
    await writeNextReactPkg(dir);
    await mkdir(join(dir, "components"), { recursive: true });
    await writeFile(
      join(dir, "components/Button.tsx"),
      "export const Button = () => null;\n",
    );

    await greetCmd({
      cwd: dir,
      isTTYOverride: true,
      prompt: async () => GREET_ADOPT_INDEX,
    });

    const cfg = JSON.parse(await readFile(join(dir, ".claude-ds.json"), "utf8"));
    expect(cfg.mode).toBe("warn");
  });
});
