import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseExceptions } from "../exceptions.js";
import { info } from "../log.js";
import type { Violation } from "./run-check-scripts.js";

/**
 * Interactive review of check-script violations. For each, prompt
 * [F]ix-now / [R]egister-exception / [S]kip. Registered exceptions append to
 * `design-system/exceptions.json` with a 90-day expiry.
 *
 * Side-effect orchestration helper: prompts on stdin/stdout and writes a
 * single file (exceptions.json). Kept inline-shaped because the prompt-driven
 * flow is command-shaped, not bytes-shaped.
 *
 * Non-TTY behaviour (issue #49): stdin is slurped upfront and replayed line by
 * line so piped answers don't race EOF on the second question.
 */
export async function reviewExceptions(cwd: string, violations: Violation[], dryRun: boolean): Promise<void> {
  if (dryRun) {
    if (violations.length > 0) {
      info(`[dry-run] ${violations.length} violation(s) found (would prompt for each):`);
      for (const v of violations) info(`  [${v.ruleId}] ${v.file}: ${v.message}`);
    }
    return;
  }

  if (violations.length === 0) {
    info("check pass: no violations found");
    return;
  }

  const exPath = join(cwd, "design-system", "exceptions.json");
  let cur: import("../exceptions.js").Exception[];
  try {
    cur = parseExceptions(await readFile(exPath, "utf8"));
  } catch {
    cur = [];
  }

  const isTTY = process.stdin.isTTY === true;
  type Asker = (prompt: string) => Promise<string>;
  let ask: Asker;
  let closeAsker: () => void;

  if (isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    ask = (prompt: string) => rl.question(prompt);
    closeAsker = () => rl.close();
  } else {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      process.stdin.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      process.stdin.on("end", () => resolve());
      process.stdin.on("error", () => resolve());
      process.stdin.resume();
    });
    const buffered = Buffer.concat(chunks).toString("utf8");
    const lines = buffered.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    let cursor = 0;
    ask = async (prompt: string) => {
      process.stdout.write(prompt);
      const v = cursor < lines.length ? lines[cursor++] : "";
      process.stdout.write(v + "\n");
      return v;
    };
    closeAsker = () => {};
  }

  for (const v of violations) {
    process.stdout.write(`\nViolation: [${v.ruleId}] ${v.file}\n  ${v.message}\n`);
    const choice = (await ask("[F]ix now / [R]egister exception / [S]kip: ")).trim().toUpperCase();

    if (choice.startsWith("R")) {
      const reason = (await ask("Reason: ")).trim();
      if (!reason) { info("  skipped (no reason provided)"); continue; }
      const expiry = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const relFile = v.file.startsWith(cwd + "/") ? v.file.slice(cwd.length + 1) : v.file;
      cur.push({ rule_id: v.ruleId, file: relFile, reason, expiry });
      info(`  registered exception (expiry=${expiry})`);
    } else if (choice.startsWith("F")) {
      info("  open the file and resolve the violation manually, then re-run reconform");
    } else {
      info("  skipped");
    }
  }

  closeAsker();
  await writeFile(exPath, JSON.stringify({ exceptions: cur }, null, 2) + "\n", "utf8");
  info(`exceptions.json updated (${cur.length} total)`);
}
