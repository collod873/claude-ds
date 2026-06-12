import { describe, expect, it } from "vitest";
import { diffFile, type FileVerdict } from "../../src/lib/sync-diff";

describe("sync-diff (managed)", () => {
	it("rewrite when upstream changes and on-disk matches previous", () => {
		const v = diffFile({ category: "managed" }, { prev: "A", upstream: "B", current: "A" });
		expect(v).toEqual<FileVerdict>({ action: "rewrite", reason: "upstream changed" });
	});
	it("rewrite when on-disk diverges from previous (hand-edited managed file)", () => {
		const v = diffFile(
			{ category: "managed" },
			{ prev: "A", upstream: "B", current: "A-modified" },
		);
		expect(v.action).toBe("rewrite");
		expect(v.reason).toContain("had local edits");
		expect(v.reason).toContain("original in git history");
	});
	it("skip when nothing changed", () => {
		const v = diffFile({ category: "managed" }, { prev: "A", upstream: "A", current: "A" });
		expect(v.action).toBe("skip");
	});
});

describe("sync-diff (consumer-legible reasons, #592)", () => {
	// Internal-glossary terms that must never reach a rendered reason string.
	const FORBIDDEN = ["hybrid json", "seeded; never re-touched", "marker region"];

	function reasonOf(
		info: Parameters<typeof diffFile>[0],
		d: Parameters<typeof diffFile>[1],
	): string {
		return diffFile(info, d).reason;
	}

	it("seeded skip reads plainly and names neither 'seeded' nor 're-touched'", () => {
		const r = reasonOf({ category: "seeded" }, { prev: null, upstream: "X", current: "X" });
		expect(r).toBe("set up once at adopt; never overwritten");
	});

	it("hybrid-json in-sync skip says 'pack-owned keys unchanged'", () => {
		const settings = `${JSON.stringify({ hooks: {} }, null, 2)}\n`;
		const r = reasonOf(
			{ category: "hybrid", format: "json" },
			{ prev: null, upstream: settings, current: settings },
		);
		expect(r).toBe("pack-owned keys unchanged");
	});

	it("hybrid-json rewrite says 'pack-owned keys changed upstream'", () => {
		const upstream = `${JSON.stringify({ hooks: { PostToolUse: [{ a: 1 }] } }, null, 2)}\n`;
		const current = `${JSON.stringify({ hooks: {} }, null, 2)}\n`;
		const r = reasonOf({ category: "hybrid", format: "json" }, { prev: null, upstream, current });
		expect(r).toBe("pack-owned keys changed upstream");
	});

	it("marker in-sync skip says 'pack-managed section unchanged'", () => {
		const same =
			"outer\n<!-- >>> claude-ds managed >>> -->\nA\n<!-- <<< claude-ds managed <<< -->\n";
		const r = reasonOf(
			{ category: "hybrid", format: "markdown" },
			{ prev: same, upstream: same, current: same },
		);
		expect(r).toBe("pack-managed section unchanged");
	});

	it("marker rewrite-region says 'pack-managed section changed upstream'", () => {
		const r = reasonOf(
			{ category: "hybrid", format: "markdown" },
			{
				prev: "o\n<!-- >>> claude-ds managed >>> -->\nA\n<!-- <<< claude-ds managed <<< -->\n",
				upstream: "o\n<!-- >>> claude-ds managed >>> -->\nB\n<!-- <<< claude-ds managed <<< -->\n",
				current: "o\n<!-- >>> claude-ds managed >>> -->\nA\n<!-- <<< claude-ds managed <<< -->\n",
			},
		);
		expect(r).toBe("pack-managed section changed upstream");
	});

	it("no verdict reason leaks an internal-glossary term", () => {
		const markerBlock = (inner: string) =>
			`o\n<!-- >>> claude-ds managed >>> -->\n${inner}\n<!-- <<< claude-ds managed <<< -->\n`;
		const reasons = [
			reasonOf({ category: "seeded" }, { prev: null, upstream: "X", current: "X" }),
			reasonOf(
				{ category: "hybrid", format: "json" },
				{ prev: null, upstream: '{\n  "hooks": {}\n}\n', current: '{\n  "hooks": {}\n}\n' },
			),
			reasonOf(
				{ category: "hybrid", format: "json" },
				{ prev: null, upstream: '{\n  "hooks": {"x":[1]}\n}\n', current: '{\n  "hooks": {}\n}\n' },
			),
			reasonOf(
				{ category: "hybrid", format: "markdown" },
				{ prev: markerBlock("A"), upstream: markerBlock("A"), current: markerBlock("A") },
			),
			reasonOf(
				{ category: "hybrid", format: "markdown" },
				{ prev: markerBlock("A"), upstream: markerBlock("B"), current: markerBlock("A") },
			),
		];
		for (const r of reasons) {
			for (const term of FORBIDDEN) {
				expect(r.toLowerCase()).not.toContain(term);
			}
		}
	});
});

describe("sync-diff (missing on disk)", () => {
	it("reports 'new in this version' when the file was never tracked (prev=null)", () => {
		const v = diffFile({ category: "managed" }, { prev: null, upstream: "B", current: null });
		expect(v.action).toBe("rewrite");
		expect(v.reason).toContain("new in this version");
		expect(v.reason).not.toContain("missing on disk");
	});
	it("reports 'missing on disk — recreating' only when a tracked file was deleted (prev set)", () => {
		const v = diffFile({ category: "managed" }, { prev: "A", upstream: "B", current: null });
		expect(v.action).toBe("rewrite");
		expect(v.reason).toBe("missing on disk — recreating");
	});
});

describe("sync-diff (hybrid markdown)", () => {
	it("rewrites only the marker region", () => {
		const v = diffFile(
			{ category: "hybrid", format: "markdown" },
			{
				prev: "outer\n<!-- >>> claude-ds managed >>> -->\nA\n<!-- <<< claude-ds managed <<< -->\n",
				upstream:
					"outer\n<!-- >>> claude-ds managed >>> -->\nB\n<!-- <<< claude-ds managed <<< -->\n",
				current:
					"USER OUTER\n<!-- >>> claude-ds managed >>> -->\nA\n<!-- <<< claude-ds managed <<< -->\nMORE USER\n",
			},
		);
		expect(v.action).toBe("rewrite-region");
		if (v.action === "rewrite-region") expect(v.newContent).toContain("USER OUTER");
	});
});

describe("sync-diff (hybrid json)", () => {
	// Realistic pack hook shape — commands under .claude/hooks/ namespace
	const packHookEntry = {
		matcher: "Edit|Write",
		hooks: [{ type: "command", command: ".claude/hooks/atom-imports.sh" }],
	};

	const makeSettings = (hooks: unknown, extra?: Record<string, unknown>) =>
		`${JSON.stringify({ hooks, ...extra }, null, 2)}\n`;

	it("returns rewrite when pack adds new hooks not yet in current", () => {
		const upstream = makeSettings({ PostToolUse: [packHookEntry] });
		const current = makeSettings({}, { permissions: ["read"] });
		const v = diffFile({ category: "hybrid", format: "json" }, { prev: null, upstream, current });
		expect(v.action).toBe("rewrite");
	});

	it("rewrite result preserves user-owned permissions key and adds pack hooks", () => {
		const upstream = makeSettings({ PostToolUse: [packHookEntry] });
		const current = makeSettings({}, { permissions: ["read"] });
		const v = diffFile({ category: "hybrid", format: "json" }, { prev: null, upstream, current });
		expect(v.action).toBe("rewrite");
		expect(v).toHaveProperty("newContent");
		if (v.action === "rewrite" && "newContent" in v) {
			const parsed = JSON.parse((v as { newContent: string }).newContent);
			expect(parsed.permissions).toEqual(["read"]);
			expect(parsed.hooks.PostToolUse).toBeDefined();
			expect(parsed.hooks.PostToolUse[0].hooks[0].command).toContain(".claude/hooks/");
		}
	});

	it("returns skip when pack hooks already present in current (no effective change)", () => {
		// current already has the pack hook — merged result should equal current
		const upstream = makeSettings({ PostToolUse: [packHookEntry] });
		const current = makeSettings({ PostToolUse: [packHookEntry] }, { permissions: ["read"] });
		const v = diffFile({ category: "hybrid", format: "json" }, { prev: null, upstream, current });
		expect(v.action).toBe("skip");
	});

	it("uses owned_keys from EntryInfo — scripts key merged, not hooks", () => {
		const upstream = `${JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }, null, 2)}\n`;
		const current = `${JSON.stringify({ scripts: {}, devDependencies: { typescript: "^5" } }, null, 2)}\n`;
		const v = diffFile(
			{ category: "hybrid", format: "json", owned_keys: ["scripts"] },
			{ prev: null, upstream, current },
		);
		// upstream added scripts.build and scripts.test — should rewrite
		expect(v.action).toBe("rewrite");
		expect(v).toHaveProperty("newContent");
		if (v.action === "rewrite" && "newContent" in v) {
			const parsed = JSON.parse((v as { newContent: string }).newContent);
			// scripts from upstream propagated
			expect(parsed.scripts.build).toBe("tsc");
			expect(parsed.scripts.test).toBe("vitest");
			// user key preserved
			expect(parsed.devDependencies).toEqual({ typescript: "^5" });
			// no spurious hooks key introduced
			expect(parsed.hooks).toBeUndefined();
		}
	});

	it("user-owned permissions preserved even if upstream has different permissions value", () => {
		const upstream = `${JSON.stringify(
			{
				hooks: { PostToolUse: [packHookEntry] },
				permissions: ["upstream-only"],
			},
			null,
			2,
		)}\n`;
		const current = `${JSON.stringify(
			{
				hooks: { PostToolUse: [packHookEntry] },
				permissions: ["current-perm"],
			},
			null,
			2,
		)}\n`;
		const v = diffFile({ category: "hybrid", format: "json" }, { prev: null, upstream, current });
		// hooks identical — skip
		expect(v.action).toBe("skip");
	});
});
