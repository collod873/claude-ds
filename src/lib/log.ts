import { createInterface } from "node:readline/promises";
export function info(msg: string): void { console.log(msg); }
export function err(msg: string): void { console.error(msg); }
export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return ans === "y" || ans === "yes";
}
