import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export async function freshTmpDir(prefix = "claude-ds-"): Promise<string> {
	return await mkdtemp(join(tmpdir(), prefix));
}
export async function cleanup(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}
