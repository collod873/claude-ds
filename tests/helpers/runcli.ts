import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export interface RunResult { code: number; stdout: string; stderr: string; }
const CLI_PATH = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
export async function runCli(args: string[], opts: { cwd: string; stdin?: string; env?: NodeJS.ProcessEnv } = { cwd: process.cwd() }): Promise<RunResult> {
  return await new Promise((res) => {
    const child = spawn("npx", ["tsx", CLI_PATH, ...args], { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (opts.stdin) child.stdin.end(opts.stdin);
    child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
  });
}
