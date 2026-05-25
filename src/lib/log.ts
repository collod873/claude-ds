import { createInterface } from "node:readline/promises";
export function info(msg: string): void { console.log(msg); }
export function err(msg: string): void { console.error(msg); }
export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let ans: string;
  try {
    ans = await Promise.race([
      rl.question(`${question} [y/N] `),
      new Promise<string>((resolve) => rl.once("close", () => resolve(""))),
    ]);
  } catch {
    ans = "";
  } finally {
    rl.close();
  }
  return ans.trim().toLowerCase() === "y" || ans.trim().toLowerCase() === "yes";
}
