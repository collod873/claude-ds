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
  const makeSettings = (hooks: unknown, extra?: Record<string, unknown>) =>
    JSON.stringify({ hooks, ...extra }, null, 2) + "\n";

  it("returns rewrite when hooks differ between upstream and current", () => {
    const upstream = makeSettings({ post: "new-hook" });
    const current = makeSettings({ post: "old-hook" }, { permissions: ["read"] });
    const v = diffFile({ category: "hybrid", format: "json" }, { prev: null, upstream, current });
    expect(v.action).toBe("rewrite");
  });

  it("rewrite result preserves user-owned permissions key", () => {
    const upstream = makeSettings({ post: "new-hook" });
    const current = makeSettings({ post: "old-hook" }, { permissions: ["read"] });
    const v = diffFile({ category: "hybrid", format: "json" }, { prev: null, upstream, current });
    expect(v.action).toBe("rewrite");
    // rewrite for hybrid+json carries newContent with the merged result
    expect(v).toHaveProperty("newContent");
    if (v.action === "rewrite" && "newContent" in v) {
      const parsed = JSON.parse((v as { newContent: string }).newContent);
      expect(parsed.permissions).toEqual(["read"]);
      expect(parsed.hooks).toEqual({ post: "new-hook" });
    }
  });

  it("returns skip when merged result equals current (no effective change)", () => {
    const upstream = makeSettings({ post: "same-hook" });
    const current = makeSettings({ post: "same-hook" }, { permissions: ["read"] });
    const v = diffFile({ category: "hybrid", format: "json" }, { prev: null, upstream, current });
    expect(v.action).toBe("skip");
  });

  it("user-owned key in current is preserved even if upstream has different value", () => {
    const upstream = JSON.stringify({ hooks: { a: 1 }, permissions: ["upstream-only"] }, null, 2) + "\n";
    const current = JSON.stringify({ hooks: { a: 1 }, permissions: ["current-perm"] }, null, 2) + "\n";
    const v = diffFile({ category: "hybrid", format: "json" }, { prev: null, upstream, current });
    // hooks identical so result should be skip
    expect(v.action).toBe("skip");
  });
});
