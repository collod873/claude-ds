import { describe, it, expect } from "vitest";
import { diffFile, FileVerdict } from "../../src/lib/sync-diff";

describe("sync-diff (managed)", () => {
  it("rewrite when upstream changes and on-disk matches previous", () => {
    const v = diffFile({ category: "managed" }, { prev: "A", upstream: "B", current: "A" });
    expect(v).toEqual<FileVerdict>({ action: "rewrite", reason: "upstream changed" });
  });
  it("abort when on-disk diverges from previous (hand-edited managed file)", () => {
    const v = diffFile({ category: "managed" }, { prev: "A", upstream: "B", current: "A-modified" });
    expect(v.action).toBe("abort");
  });
  it("skip when nothing changed", () => {
    const v = diffFile({ category: "managed" }, { prev: "A", upstream: "A", current: "A" });
    expect(v.action).toBe("skip");
  });
});

describe("sync-diff (hybrid markdown)", () => {
  it("rewrites only the marker region", () => {
    const v = diffFile({ category: "hybrid", format: "markdown" }, {
      prev: "outer\n<!-- >>> claude-ds managed >>> -->\nA\n<!-- <<< claude-ds managed <<< -->\n",
      upstream: "outer\n<!-- >>> claude-ds managed >>> -->\nB\n<!-- <<< claude-ds managed <<< -->\n",
      current: "USER OUTER\n<!-- >>> claude-ds managed >>> -->\nA\n<!-- <<< claude-ds managed <<< -->\nMORE USER\n",
    });
    expect(v.action).toBe("rewrite-region");
    if (v.action === "rewrite-region") expect(v.newContent).toContain("USER OUTER");
  });
});

describe("sync-diff (hybrid json)", () => {
  // Realistic pack hook shape — commands under .claude/hooks/ namespace
  const packHookEntry = {
    matcher: "Edit|Write",
    hooks: [{ type: "command", command: ".claude/hooks/atom-imports.sh $CLAUDE_FILE_PATHS" }],
  };

  const makeSettings = (hooks: unknown, extra?: Record<string, unknown>) =>
    JSON.stringify({ hooks, ...extra }, null, 2) + "\n";

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
    const upstream = JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }, null, 2) + "\n";
    const current = JSON.stringify({ scripts: {}, devDependencies: { typescript: "^5" } }, null, 2) + "\n";
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
    const upstream = JSON.stringify({
      hooks: { PostToolUse: [packHookEntry] },
      permissions: ["upstream-only"],
    }, null, 2) + "\n";
    const current = JSON.stringify({
      hooks: { PostToolUse: [packHookEntry] },
      permissions: ["current-perm"],
    }, null, 2) + "\n";
    const v = diffFile({ category: "hybrid", format: "json" }, { prev: null, upstream, current });
    // hooks identical — skip
    expect(v.action).toBe("skip");
  });
});
