import { spawn } from "node:child_process";
import { resolve } from "node:path";
export interface RunResult { code: number; stdout: string; stderr: string; }
export async function runCli(args: string[], opts: { cwd: string; stdin?: string } = { cwd: process.cwd() }): Promise<RunResult> {
  return await new Promise((res) => {
    const cli = resolve(process.cwd(), "src/cli.ts");
    const child = spawn("npx", ["tsx", cli, ...args], { cwd: opts.cwd });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (opts.stdin) child.stdin.end(opts.stdin);
    child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
  });
}
