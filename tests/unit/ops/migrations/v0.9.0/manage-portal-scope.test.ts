import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "../../../../../src/lib/manifest.js";
import { managePortalScope } from "../../../../../src/lib/ops/migrations/v0.9.0/manage-portal-scope.js";
import type { ProjectContext } from "../../../../../src/lib/project.js";
import { cleanup, freshTmpDir } from "../../../../helpers/tmpdir.js";

const PORTAL_CSS_PATH = "design-system/utils/portal-scope.module.css";

const emptyManifest: Manifest = {
	files: [],
	canonical_paths: [],
	lookalike_ignore: [],
	deprecated_paths: [],
	managed_roots: [],
};

let cwd: string;
let packDir: string;

beforeEach(async () => {
	cwd = await freshTmpDir("manage-portal-scope-cwd-");
	packDir = await freshTmpDir("manage-portal-scope-pack-");
	await mkdir(join(packDir, "files", "design-system", "utils"), { recursive: true });
});
afterEach(async () => {
	await cleanup(cwd);
	await cleanup(packDir);
});

function makeCtx(): ProjectContext {
	return {
		cwd,
		cfg: {
			version: "v0.8.0",
			pack: "next-react",
			mode: "warn",
			enforce_threshold: 10,
			removed: [],
			lookalike_ignore: [],
			app_dir: "app",
			claude_md_target: ".claude/CLAUDE.md",
		},
		packDir,
		manifest: emptyManifest,
		exists: async (p: string) => {
			try {
				await stat(join(cwd, p));
				return true;
			} catch {
				return false;
			}
		},
		decisions: {},
	};
}

const PACK_CONTENT = ".portalScope {\n  display: contents;\n}\n";

describe("managePortalScope migration op", () => {
	beforeEach(async () => {
		await writeFile(join(packDir, "files", PORTAL_CSS_PATH), PACK_CONTENT);
	});

	it("emits a write Change when file does not exist in consumer project", async () => {
		const changes = await managePortalScope.plan(makeCtx());
		expect(changes).toHaveLength(1);
		const c = changes[0];
		expect(c.kind).toBe("write");
		if (c.kind !== "write") return;
		expect(c.path).toBe(PORTAL_CSS_PATH);
		expect(c.before).toBeNull();
		expect(c.after.toString("utf8")).toBe(PACK_CONTENT);
	});

	it("emits no Change when file already matches pack content (idempotent)", async () => {
		await mkdir(join(cwd, "design-system", "utils"), { recursive: true });
		await writeFile(join(cwd, PORTAL_CSS_PATH), PACK_CONTENT);

		const changes = await managePortalScope.plan(makeCtx());
		expect(changes).toHaveLength(0);
	});

	it("emits a write Change when file exists with different content", async () => {
		await mkdir(join(cwd, "design-system", "utils"), { recursive: true });
		await writeFile(
			join(cwd, PORTAL_CSS_PATH),
			"/* hand-rolled version */\n.portalScope { display: contents; }\n",
		);

		const changes = await managePortalScope.plan(makeCtx());
		expect(changes).toHaveLength(1);
		const c = changes[0];
		expect(c.kind).toBe("write");
		if (c.kind !== "write") return;
		expect(c.after.toString("utf8")).toBe(PACK_CONTENT);
	});

	it("op name is manage-portal-scope@v0.9.0", () => {
		expect(managePortalScope.name).toBe("manage-portal-scope@v0.9.0");
	});
});
