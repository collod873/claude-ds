import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../../../src/lib/operation";
import { manageForceState } from "../../../../src/lib/ops/migrations/v0.8.0/manage-force-state";
import type { ProjectContext } from "../../../../src/lib/project";
import { cleanup, freshTmpDir } from "../../../helpers/tmpdir";

const FILE_PATH = "design-system/utils/force-state.css";
const PACK_CONTENT =
	"/* force-state pack content */\n@custom-variant hover (&:hover, .force-hover &);\n";
const LOCAL_CONTENT = "/* hand-rolled force-state */\n";

let cwd: string;
let packDir: string;

beforeEach(async () => {
	cwd = await freshTmpDir("manage-force-state-cwd-");
	packDir = await freshTmpDir("manage-force-state-pack-");
	await mkdir(join(packDir, "files", "design-system/utils"), { recursive: true });
	await writeFile(join(packDir, "files", FILE_PATH), PACK_CONTENT, "utf8");
});

afterEach(async () => {
	await cleanup(cwd);
	await cleanup(packDir);
});

function makeCtx(overrides: Partial<ProjectContext> = {}): ProjectContext {
	return {
		cwd,
		cfg: {} as ProjectContext["cfg"],
		packDir,
		manifest: {} as ProjectContext["manifest"],
		exists: async (p: string) => {
			try {
				await stat(join(cwd, p));
				return true;
			} catch {
				return false;
			}
		},
		decisions: {},
		...overrides,
	};
}

describe("manageForceState migration op", () => {
	it("emits a write Change with before=null when file is absent", async () => {
		const changes = await manageForceState.plan(makeCtx());
		expect(changes).toHaveLength(1);
		const c = changes[0] as Extract<Change, { kind: "write" }>;
		expect(c.kind).toBe("write");
		expect(c.path).toBe(FILE_PATH);
		expect(c.before).toBeNull();
		expect(c.after.toString("utf8")).toBe(PACK_CONTENT);
	});

	it("emits a write Change replacing local hand-rolled copy", async () => {
		await mkdir(join(cwd, "design-system/utils"), { recursive: true });
		await writeFile(join(cwd, FILE_PATH), LOCAL_CONTENT, "utf8");
		const changes = await manageForceState.plan(makeCtx());
		expect(changes).toHaveLength(1);
		const c = changes[0] as Extract<Change, { kind: "write" }>;
		expect(c.kind).toBe("write");
		expect(c.path).toBe(FILE_PATH);
		expect(c.before?.toString("utf8")).toBe(LOCAL_CONTENT);
		expect(c.after.toString("utf8")).toBe(PACK_CONTENT);
	});

	it("returns no Changes when file already matches pack version (idempotent)", async () => {
		await mkdir(join(cwd, "design-system/utils"), { recursive: true });
		await writeFile(join(cwd, FILE_PATH), PACK_CONTENT, "utf8");
		const changes = await manageForceState.plan(makeCtx());
		expect(changes).toEqual([]);
	});
});
